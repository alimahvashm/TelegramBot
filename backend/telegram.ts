import { createHash } from 'node:crypto';
import type { Config } from '../shared/config.js';
import { summaryCount } from '../shared/config.js';
import { AudioService, MAX_BYTES, MAX_SECONDS } from './audio.js';
import { AppError, boundedBody, delay, fetchJson } from './http.js';
import { createEducationNotes, summarize } from './providers.js';
import { renderEducationPdf } from './education-pdf.js';
import { Store, type Chat } from './store.js';

type User = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
};
type Media = { file_id: string; file_size?: number; duration?: number };
type Message = {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; first_name?: string };
  from?: User;
  sender_chat?: { title?: string };
  text?: string;
  caption?: string;
  reply_to_message?: Message;
  voice?: Media;
  audio?: Media;
  video_note?: Media;
  document?: { file_name?: string };
};
type Update = { update_id: number; message?: Message };
export type BotStatus = {
  state: 'stopped' | 'connecting' | 'polling' | 'conflict' | 'error';
  error: string | null;
  bot: User | null;
  lastPoll: number | null;
};
export const chunks = (text: string, length = 3900) => {
  const result: string[] = [];
  const points = Array.from(text);
  for (let i = 0; i < points.length; i += length) result.push(points.slice(i, i + length).join(''));
  return result;
};

export class TelegramBot {
  status: BotStatus = { state: 'stopped', error: null, bot: null, lastPoll: null };
  private controller?: AbortController;
  private running?: Promise<void>;
  private controls = Promise.resolve();
  private educationTimes = new Map<string, number>();
  private summaryTimes = new Map<string, number>();
  constructor(
    private store: Store,
    private audio: AudioService,
    private pdfRenderer: (notes: string) => Promise<Buffer> = renderEducationPdf,
  ) {}
  async call<T>(
    token: string,
    method: string,
    data: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await fetchJson<{ ok: boolean; result: T; error_code?: number }>(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal,
      },
      method === 'getUpdates' ? 40000 : 20000,
    );
    if (!result.ok) throw new AppError('Telegram API request failed.', result.error_code || 502);
    return result.result;
  }
  reconcile() {
    const control = this.controls.then(async () => {
      await this.stop();
      this.status = { state: 'stopped', error: null, bot: null, lastPoll: null };
      const config = this.store.config;
      if (!config.enabled || !config.token) return;
      this.controller = new AbortController();
      this.running = this.loop(config.token, this.controller.signal);
    });
    this.controls = control.catch(() => {});
    return control;
  }
  async stop() {
    this.controller?.abort();
    await this.running;
    this.running = undefined;
    this.status.state = 'stopped';
  }
  private async loop(token: string, signal: AbortSignal) {
    const identity = createHash('sha256').update(token).digest('hex').slice(0, 20);
    let failures = 0;
    let pollOffset = this.store.state.offsets[identity] || 0;
    const pending: { id: number; done: boolean }[] = [];
    const chatQueues = new Map<string, Promise<void>>();
    const jobs = new Set<Promise<void>>();
    const enqueue = (update: Update) => {
      const entry = { id: update.update_id, done: false };
      pending.push(entry);
      const chatId = update.message ? String(update.message.chat.id) : `update:${entry.id}`;
      const previous = chatQueues.get(chatId) || Promise.resolve();
      const job = previous.then(async () => {
        try {
          if (update.message) await this.handle(token, update.message, this.store.config);
        } catch {
          this.store.log('error', 'Message processing failed; the update has been recorded.');
        }
        entry.done = true;
        while (pending[0]?.done) {
          this.store.state.offsets[identity] = pending.shift()!.id + 1;
        }
        await this.store.saveState();
      });
      const settled = job.catch(() => this.store.log('error', 'Could not save processed update state.'));
      chatQueues.set(chatId, settled);
      jobs.add(settled);
      void settled.then(() => {
        jobs.delete(settled);
        if (chatQueues.get(chatId) === settled) chatQueues.delete(chatId);
      });
    };
    while (!signal.aborted) {
      try {
        if (!this.status.bot) {
          this.status.state = 'connecting';
          this.status.bot = await this.call<User>(token, 'getMe', {}, signal);
          const webhook = await this.call<{ url: string }>(token, 'getWebhookInfo', {}, signal);
          if (webhook.url)
            throw new AppError('A webhook is active. Remove it before starting long polling.', 409);
          this.store.log(
            'info',
            `Connected to @${this.status.bot.username || this.status.bot.id}.`,
          );
        }
        const updates = await this.call<Update[]>(
          token,
          'getUpdates',
          {
            offset: pollOffset,
            timeout: 30,
            limit: 20,
            allowed_updates: ['message'],
          },
          signal,
        );
        this.status.state = 'polling';
        this.status.error = null;
        this.status.lastPoll = Date.now();
        failures = 0;
        for (const update of updates) {
          if (signal.aborted) break;
          if (update.update_id < pollOffset) continue;
          enqueue(update);
          pollOffset = update.update_id + 1;
        }
        if (jobs.size >= 100) await Promise.race(jobs);
      } catch (error) {
        if (signal.aborted) break;
        const code = error instanceof AppError ? error.status : 0;
        this.status.state = code === 409 ? 'conflict' : 'error';
        this.status.error =
          code === 409
            ? 'Telegram conflict: another poller or webhook is using this token. Stop the other instance, then restart here.'
            : code === 401
              ? 'Telegram rejected the bot token.'
              : 'Telegram is temporarily unavailable. Retrying automatically.';
        this.store.log('error', this.status.error);
        if (code === 401 || code === 409) break;
        this.status.bot = null;
        await delay(Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)), signal);
      }
    }
    await Promise.all(jobs);
  }
  private async reply(token: string, message: Message, text: string) {
    for (const part of chunks(text))
      await this.call(token, 'sendMessage', {
        chat_id: message.chat.id,
        text: part,
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      });
  }
  private async sendPdf(token: string, message: Message, pdf: Buffer) {
    const form = new FormData();
    form.append('chat_id', String(message.chat.id));
    form.append('caption', '📚 جزوهٔ آموزشی');
    form.append(
      'reply_parameters',
      JSON.stringify({
        message_id: message.message_id,
        allow_sending_without_reply: true,
      }),
    );
    form.append(
      'document',
      new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }),
      'education-notes.pdf',
    );
    const result = await fetchJson<{ ok: boolean }>(
      `https://api.telegram.org/bot${token}/sendDocument`,
      {
        method: 'POST',
        body: form,
      },
      120000,
    );
    if (!result.ok) throw new AppError('Telegram did not accept the PDF document.', 502);
  }
  private chat(message: Message, config: Config): Chat {
    const id = String(message.chat.id);
    const existing = this.store.state.chats[id];
    const chat = existing || {
      id,
      title: '',
      type: message.chat.type,
      language: config.language,
      enabled: true,
      memberCount: null,
      membersUpdatedAt: 0,
      messageCount: 0,
      audioCount: 0,
      lastActive: 0,
      history: [],
    };
    chat.title = message.chat.title || message.chat.first_name || `Chat ${id}`;
    chat.type = message.chat.type;
    chat.lastActive = Date.now();
    chat.messageCount++;
    const day = new Date().toISOString().slice(0, 10);
    chat.dailyMessages ||= {};
    chat.dailyMessages[day] = (chat.dailyMessages[day] || 0) + 1;
    this.store.state.chats[id] = chat;
    if (message.from) this.store.state.users[String(message.from.id)] = Date.now();
    return chat;
  }
  private async handle(token: string, message: Message, config: Config) {
    if (message.from?.is_bot) return;
    const chat = this.chat(message, config);
    if (!chat.enabled) return;
    if (chat.type !== 'private' && Date.now() - chat.membersUpdatedAt > 3600000) {
      chat.membersUpdatedAt = Date.now();
      try {
        chat.memberCount = await this.call<number>(token, 'getChatMemberCount', {
          chat_id: message.chat.id,
        });
      } catch {
        /* The bot may not have member access. */
      }
    }
    const match = message.text?.match(/^\/(\w+)(?:@([\w]+))?(?:\s+(.*))?$/s);
    if (
      match &&
      (!match[2] || match[2].toLowerCase() === this.status.bot?.username?.toLowerCase())
    ) {
      const [, command, , argument] = match;
      if (command === 'start') {
        await this.reply(token, message, config.startMessage);
        return;
      }
      if (command === 'language') {
        if (chat.type !== 'private') {
          const member = await this.call<{ status: string }>(token, 'getChatMember', {
            chat_id: message.chat.id,
            user_id: message.from?.id,
          });
          if (!['creator', 'administrator'].includes(member.status)) {
            await this.reply(
              token,
              message,
              'Only group administrators can change the group language.',
            );
            return;
          }
        }
        if (argument === 'fa-IR' || argument === 'en-US') {
          chat.language = argument;
          await this.reply(token, message, `Recognition language: ${argument}`);
        } else await this.reply(token, message, 'Use /language fa-IR or /language en-US.');
        return;
      }
      if (command === 'education') {
        await this.education(token, message, chat, config);
        return;
      }
      if (command === 'summary') {
        await this.summary(token, message, chat, config, argument?.trim());
        return;
      }
    }
    const sender =
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
      message.sender_chat?.title ||
      'Unknown';
    const remember = (text: string) =>
      this.store.remember(chat, {
        messageId: message.message_id,
        timestamp: message.date * 1000,
        sender,
        text,
      });
    const text =
      message.text ||
      message.caption ||
      (message.document ? `[Shared file: ${message.document.file_name || 'unnamed'}]` : '');
    if (text) remember(text);
    const media = message.voice || message.audio || message.video_note;
    if (!media) return;
    chat.audioCount++;
    this.store.state.metrics.processed++;
    this.store.log('info', `Incoming audio in chat ${chat.id}.`);
    let transcription: string;
    try {
      transcription = await this.transcribeMedia(token, media, config, chat.language);
      remember([text, `[Voice transcript] ${transcription}`].filter(Boolean).join('\n'));
      this.store.state.metrics.succeeded++;
    } catch (error) {
      this.store.state.metrics.failed++;
      this.store.log(
        'warn',
        `Audio processing failed in chat ${chat.id} (${config.transcribeMode}${error instanceof AppError ? `, HTTP ${error.status}` : ', network or runtime error'}).`,
      );
      if (config.autoReply)
        await this.reply(
          token,
          message,
          error instanceof AppError && [413, 422].includes(error.status)
            ? error.message
            : 'Transcription is unavailable. Please try again later or ask the bot administrator to check the speech provider.',
        );
      return;
    }
    if (config.autoReply) {
      await this.reply(token, message, transcription);
      this.store.log('info', `Transcript reply delivered to chat ${chat.id}.`);
    }
  }
  private async transcribeMedia(
    token: string,
    media: Media,
    config: Config,
    language: Config['language'],
    progress?: (done: number, total: number) => Promise<void>,
  ) {
    if ((media.file_size || 0) > MAX_BYTES || (media.duration || 0) > MAX_SECONDS)
      throw new AppError('Audio must be under 20 MB and 60 minutes.', 413);
    const file = await this.call<{ file_path?: string; file_size?: number }>(token, 'getFile', {
      file_id: media.file_id,
    });
    if (!file.file_path || (file.file_size || 0) > MAX_BYTES)
      throw new AppError('Telegram file is unavailable or exceeds 20 MB.', 413);
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('Telegram audio download failed.', 502);
    }
    const result = await this.audio.process(
      await boundedBody(response, MAX_BYTES),
      config,
      language,
      false,
      progress,
    );
    return result.text;
  }

  private async education(token: string, message: Message, chat: Chat, config: Config) {
    const source = message.reply_to_message;
    const media = source?.voice || source?.audio || source?.video_note;
    if (!media) {
      await this.reply(
        token,
        message,
        '📚 برای ساخت جزوه، روی پیام صوتی استاد ریپلای کنید و /education را بفرستید.',
      );
      return;
    }
    if (Date.now() - (this.educationTimes.get(chat.id) || 0) < 30000) {
      await this.reply(token, message, 'لطفاً بین درخواست‌های جزوه ۳۰ ثانیه صبر کنید.');
      return;
    }
    this.educationTimes.set(chat.id, Date.now());
    for (const [id, time] of this.educationTimes)
      if (Date.now() - time > 60000) this.educationTimes.delete(id);
    const progress = await this.call<{ message_id: number }>(token, 'sendMessage', {
      chat_id: message.chat.id,
      text: '⏳ در حال تبدیل صوت به متن و آماده‌سازی جزوه…',
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    });
    let output: string;
    let notesReady = false;
    let stage = 'transcription';
    this.store.state.metrics.processed++;
    try {
      const updateProgress = async (text: string) => {
        await this.call(token, 'editMessageText', {
          chat_id: message.chat.id,
          message_id: progress.message_id,
          text,
        }).catch(() => {});
      };
      const transcript = await this.transcribeMedia(
        token,
        media,
        config,
        chat.language,
        async (done, total) => {
          await updateProgress(`⏳ تبدیل صوت به متن: ${done} از ${total} بخش تکمیل شد.`);
        },
      );
      this.store.state.metrics.succeeded++;
      stage = 'education';
      const result = await createEducationNotes(
        config,
        transcript,
        (msg) => this.store.log('warn', msg),
        async (done, total) => {
          await updateProgress(`📝 آماده‌سازی جزوه: بخش ${done + 1} از ${total}`);
        },
      );
      output = result.text;
      notesReady = true;
      this.store.log('info', `Education notes generated using ${result.provider}.`);
    } catch (error) {
      if (stage === 'transcription') this.store.state.metrics.failed++;
      this.store.log(
        'warn',
        `Education ${stage} failed${error instanceof AppError ? ` (HTTP ${error.status})` : ''}.`,
      );
      output =
        stage === 'education'
          ? 'تهیهٔ جزوه موقتاً ممکن نیست. لطفاً دسترسی و سهمیهٔ مدل هوش مصنوعی را بررسی کنید و دوباره تلاش کنید.'
          : error instanceof AppError && error.status === 413
            ? 'فایل صوتی باید حداکثر ۶۰ دقیقه و کمتر از ۲۰ مگابایت باشد.'
            : error instanceof AppError && error.status === 422
              ? 'گفتار واضحی تشخیص داده نشد یا فایل صوتی قابل خواندن نیست. لطفاً صدای واضح‌تری بفرستید.'
              : 'تبدیل صوت به متن موقتاً ممکن نیست. لطفاً دوباره تلاش کنید.';
    }
    if (notesReady) {
      try {
        await this.call(token, 'editMessageText', {
          chat_id: message.chat.id,
          message_id: progress.message_id,
          text: '📄 در حال آماده‌سازی فایل PDF…',
        }).catch(() => {});
        await this.sendPdf(token, message, await this.pdfRenderer(output));
        this.store.log('info', `Education PDF delivered to chat ${chat.id}.`);
        output = '📄 جزوهٔ آموزشی به صورت PDF ارسال شد.';
      } catch (error) {
        this.store.log(
          'warn',
          `Education PDF failed${error instanceof AppError ? ` (HTTP ${error.status})` : ''}.`,
        );
        output =
          'ساخت یا ارسال PDF ممکن نشد. لطفاً دوباره تلاش کنید یا از مدیر ربات بخواهید سرویس PDF را بررسی کند.';
      }
    }
    await this.call(token, 'editMessageText', {
      chat_id: message.chat.id,
      message_id: progress.message_id,
      text: output,
    });
  }

  private async summary(
    token: string,
    message: Message,
    chat: Chat,
    config: Config,
    argument?: string,
  ) {
    let count: number;
    try {
      count = summaryCount(argument);
    } catch (error) {
      await this.reply(token, message, (error as Error).message);
      return;
    }
    this.store.prune();
    if (!chat.history.length) {
      await this.reply(
        token,
        message,
        'No conversation history yet. For groups, check the bot’s privacy mode in BotFather so it can receive messages.',
      );
      return;
    }
    if (Date.now() - (this.summaryTimes.get(chat.id) || 0) < 30000) {
      await this.reply(token, message, 'Please wait 30 seconds between summaries.');
      return;
    }
    this.summaryTimes.set(chat.id, Date.now());
    for (const [id, time] of this.summaryTimes)
      if (Date.now() - time > 60000) this.summaryTimes.delete(id);
    await this.call(token, 'sendChatAction', { chat_id: message.chat.id, action: 'typing' }).catch(
      () => {},
    );
    const progress = await this.call<{ message_id: number }>(token, 'sendMessage', {
      chat_id: message.chat.id,
      text: '⏳ Analyzing and summarizing recent messages...',
    });
    let output: string;
    try {
      const result = await summarize(config, chat.history.slice(-count), (msg) =>
        this.store.log('warn', msg),
      );
      output = result.text;
      this.store.state.metrics.summaries++;
      this.store.log(
        'info',
        `Summary generated using ${result.provider}${result.fallback ? ' (fallback)' : ''}.`,
      );
    } catch {
      output =
        'Summary temporarily unavailable. Please ask the administrator to check AI credentials, model access and quota, then try again.';
    }
    const parts = chunks(output);
    await this.call(token, 'editMessageText', {
      chat_id: message.chat.id,
      message_id: progress.message_id,
      text: parts[0],
    });
    for (const text of parts.slice(1))
      await this.call(token, 'sendMessage', { chat_id: message.chat.id, text });
  }
}
