import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { configSchema, type Config } from '../shared/config.js';

export type HistoryMessage = { messageId: number; sender: string; timestamp: number; text: string };
export type Chat = {
  id: string;
  title: string;
  type: string;
  language: 'fa-IR' | 'en-US';
  enabled: boolean;
  memberCount: number | null;
  membersUpdatedAt: number;
  messageCount: number;
  audioCount: number;
  lastActive: number;
  history: HistoryMessage[];
  dailyMessages?: Record<string, number>;
};
export type State = {
  chats: Record<string, Chat>;
  users: Record<string, number>;
  offsets: Record<string, number>;
  metrics: { processed: number; succeeded: number; failed: number; summaries: number };
};
export type Log = { id: number; time: string; level: 'info' | 'warn' | 'error'; message: string };
export class Store {
  config = configSchema.parse({});
  state: State = {
    chats: {},
    users: {},
    offsets: {},
    metrics: { processed: 0, succeeded: 0, failed: 0, summaries: 0 },
  };
  events = new EventEmitter();
  logs: Log[] = [];
  private logId = 0;
  private writes = Promise.resolve();
  constructor(public dir: string) {
    this.events.setMaxListeners(50);
  }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const envConfig = {
      token: process.env.TELEGRAM_BOT_TOKEN || '',
      enabled: process.env.BOT_ENABLED === 'true',
      chatGptApiKey: process.env.OPENAI_API_KEY || '',
      openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
      geminiApiKey: process.env.GEMINI_API_KEY || '',
      googleSpeechApiKey: process.env.GOOGLE_SPEECH_API_KEY || '',
      targetApiUrl: process.env.FASTAPI_URL || 'http://127.0.0.1:8000/voice',
    };
    this.config = configSchema.parse(await this.read('bot_config.json', envConfig));
    this.state = await this.read('chat_history.json', this.state);
    if (!this.state.chats || !this.state.metrics || !this.state.offsets || !this.state.users)
      throw new Error('Invalid chat_history.json. Restore from a backup.');
    this.prune();
  }
  private async read<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    }
  }
  private persist(name: string, value: unknown) {
    const snapshot = JSON.stringify(value, null, 2);
    const task = this.writes.then(async () => {
      const target = path.join(this.dir, name);
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, target);
    });
    this.writes = task.catch(() => {});
    return task;
  }
  async saveConfig(config: Config) {
    await this.persist('bot_config.json', config);
    this.config = config;
  }
  saveState() {
    this.prune();
    return this.persist('chat_history.json', this.state);
  }
  prune() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const chat of Object.values(this.state.chats)) {
      chat.history = chat.history.filter((m) => m.timestamp >= cutoff).slice(-200);
      if (chat.dailyMessages)
        chat.dailyMessages = Object.fromEntries(
          Object.entries(chat.dailyMessages).filter(([day]) => Date.parse(day) >= cutoff),
        );
    }
    const chats = Object.values(this.state.chats).sort((a, b) => b.lastActive - a.lastActive);
    for (const chat of chats.slice(5000)) delete this.state.chats[chat.id];
    const users = Object.entries(this.state.users)
      .filter(([, time]) => time >= cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50000);
    this.state.users = Object.fromEntries(users);
  }
  remember(chat: Chat, message: HistoryMessage) {
    if (!message.text.trim()) return;
    const existing = chat.history.findIndex((m) => m.messageId === message.messageId);
    if (existing >= 0) chat.history[existing] = message;
    else chat.history.push(message);
    chat.history = chat.history.slice(-200);
  }
  log(level: Log['level'], message: string) {
    let clean = message;
    for (const field of [
      'token',
      'chatGptApiKey',
      'openRouterApiKey',
      'geminiApiKey',
      'googleSpeechApiKey',
    ] as const) {
      if (this.config[field]) clean = clean.split(this.config[field]).join('[redacted]');
    }
    clean = clean.replace(/sk-[\w-]+/g, '[redacted]').replace(/\d{5,}:[\w-]{20,}/g, '[redacted]');
    const log: Log = {
      id: ++this.logId,
      time: new Date().toISOString(),
      level,
      message: clean.slice(0, 500),
    };
    this.logs.push(log);
    this.logs = this.logs.slice(-200);
    this.events.emit('log', log);
    console.log(JSON.stringify(log));
  }
}
