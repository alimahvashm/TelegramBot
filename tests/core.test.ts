import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema, mergeConfig, publicConfig, summaryCount } from '../shared/config.js';
import { Store, type Chat } from '../backend/store.js';
import { createAuth } from '../backend/auth.js';
import { AppError, boundedBody } from '../backend/http.js';
import { summarize, verifyOpenAI } from '../backend/providers.js';
import { AudioService } from '../backend/audio.js';
import { TelegramBot, chunks } from '../backend/telegram.js';
import { createApp } from '../server.js';

const chat = (): Chat => ({
  id: '-1001',
  title: 'Test group',
  type: 'group',
  language: 'fa-IR',
  enabled: true,
  memberCount: 3,
  membersUpdatedAt: Date.now(),
  messageCount: 0,
  audioCount: 0,
  lastActive: Date.now(),
  history: [],
});
const tempStore = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-test-'));
  const store = new Store(dir);
  await store.init();
  return store;
};
test('configuration preserves omitted/blank secrets, masks responses and supports explicit removal', () => {
  const config = configSchema.parse({ chatGptApiKey: 'sk-test-private' });
  const next = mergeConfig(config, { chatGptApiKey: '', language: 'en-US' });
  assert.equal(next.chatGptApiKey, config.chatGptApiKey);
  assert.equal(publicConfig(next).chatGptApiKey, '••••••••');
  assert.equal(publicConfig(next).credentials.chatGptApiKey, true);
  assert.equal(mergeConfig(next, { clearSecrets: ['chatGptApiKey'] }).chatGptApiKey, '');
  assert.throws(() => mergeConfig(config, { targetApiUrl: 'file:///etc/passwd' }));
  assert.throws(() => mergeConfig(config, { unknown: true }));
});
test('summary counts are bounded and Unicode replies do not split surrogate pairs', () => {
  assert.equal(summaryCount(), 30);
  assert.equal(summaryCount('500'), 100);
  assert.equal(summaryCount('0'), 1);
  assert.throws(() => summaryCount('50 bad'));
  const parts = chunks('😀'.repeat(5000));
  assert.equal(parts.join(''), '😀'.repeat(5000));
  assert.equal(Array.from(parts[0]).length, 3900);
});
test('sessions reject forgery and can be revoked', () => {
  const auth = createAuth('strong-test-password');
  const session = auth.issue();
  assert.equal(auth.verify('wrong-password'), false);
  assert.equal(auth.valid(session), true);
  assert.equal(auth.valid(session + 'tamper'), false);
  auth.revoke(session);
  assert.equal(auth.valid(session), false);
});
test('atomic state persists per-chat language, offsets, bounded history and private permissions', async () => {
  const store = await tempStore();
  try {
    const group = chat();
    group.language = 'en-US';
    store.state.chats[group.id] = group;
    for (let i = 0; i < 205; i++)
      store.remember(group, {
        messageId: i,
        sender: 'User',
        timestamp: Date.now(),
        text: String(i),
      });
    store.remember(group, {
      messageId: 204,
      sender: 'User',
      timestamp: Date.now(),
      text: 'corrected transcript',
    });
    assert.equal(group.history.length, 200);
    assert.equal(group.history.at(-1)?.text, 'corrected transcript');
    store.state.offsets.test = 42;
    await Promise.all([
      store.saveState(),
      store.saveConfig(configSchema.parse({ chatGptApiKey: 'sk-secret' })),
    ]);
    const restored = new Store(store.dir);
    await restored.init();
    assert.equal(restored.state.offsets.test, 42);
    assert.equal(restored.state.chats[group.id].language, 'en-US');
    assert.equal(restored.state.chats[group.id].history.length, 200);
    assert.equal((await stat(path.join(store.dir, 'bot_config.json'))).mode & 0o777, 0o600);
    assert.match(
      await readFile(path.join(store.dir, 'chat_history.json'), 'utf8'),
      /corrected transcript/,
    );
  } finally {
    await rm(store.dir, { recursive: true, force: true });
  }
});
test('provider falls back from OpenAI to OpenRouter and refuses to fabricate a summary without keys', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return calls.length === 1
      ? new Response('{}', { status: 401 })
      : Response.json({ choices: [{ message: { content: 'خلاصه آزمایشی' } }] });
  }) as typeof fetch;
  try {
    const messages = [
      { messageId: 1, timestamp: Date.now(), sender: 'Sara', text: 'Test conversation' },
    ];
    const result = await summarize(
      configSchema.parse({
        llmBrain: 'chatgpt',
        chatGptApiKey: 'sk-test',
        openRouterApiKey: 'sk-or-test',
      }),
      messages,
    );
    assert.equal(result.provider, 'OpenRouter');
    assert.equal(result.fallback, true);
    assert.equal(calls.length, 2);
    await assert.rejects(summarize(configSchema.parse({}), messages), /No summary provider/);
  } finally {
    globalThis.fetch = original;
  }
});
test('verification returns models and latency without reflecting the secret', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ data: [{ id: 'gpt-4o-mini' }] })) as typeof fetch;
  try {
    const result = await verifyOpenAI('sk-private-test');
    assert.equal(result.valid, true);
    assert.deepEqual(result.models, ['gpt-4o-mini']);
    assert.ok(!JSON.stringify(result).includes('sk-private'));
  } finally {
    globalThis.fetch = original;
  }
});
test('bounded downloads reject an oversized streaming response', async () => {
  await assert.rejects(
    boundedBody(new Response(new Uint8Array(100)), 50),
    (error: unknown) => error instanceof AppError && error.status === 413,
  );
});
test('polling exposes 409 conflicts and stops without a retry storm', async () => {
  const store = await tempStore();
  const original = globalThis.fetch;
  store.config = configSchema.parse({ token: '123456:abcdefghijklmnopqrstuvwxyz', enabled: true });
  let polls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('getMe'))
      return Response.json({
        ok: true,
        result: { id: 1, username: 'testbot', first_name: 'Test' },
      });
    if (String(url).endsWith('getWebhookInfo'))
      return Response.json({ ok: true, result: { url: '' } });
    polls++;
    return new Response('{}', { status: 409 });
  }) as typeof fetch;
  const bot = new TelegramBot(store, new AudioService());
  try {
    await bot.reconcile();
    for (let i = 0; i < 50 && bot.status.state !== 'conflict'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(bot.status.state, 'conflict');
    assert.equal(polls, 1);
  } finally {
    await bot.stop();
    globalThis.fetch = original;
    await rm(store.dir, { recursive: true, force: true });
  }
});
test('one busy group does not block another group or commit unfinished updates', async (t) => {
  const store = await tempStore();
  const original = globalThis.fetch;
  store.config = configSchema.parse({ token: '123456:abcdefghijklmnopqrstuvwxyz', enabled: true });
  const bot = new TelegramBot(store, new AudioService());
  const seen: number[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  t.mock.method(bot, 'handle', async (_token, message) => {
    if (message.message_id === 1) await firstHeld;
    seen.push(message.message_id);
  });
  let polled = false;
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const method = String(url).split('/').at(-1);
    if (method === 'getMe')
      return Response.json({ ok: true, result: { id: 1, username: 'testbot', first_name: 'Test' } });
    if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: '' } });
    if (!polled) {
      polled = true;
      return Response.json({ ok: true, result: [
        { update_id: 1, message: { message_id: 1, chat: { id: 10, type: 'group' } } },
        { update_id: 2, message: { message_id: 2, chat: { id: 10, type: 'group' } } },
        { update_id: 3, message: { message_id: 3, chat: { id: 20, type: 'group' } } },
      ] });
    }
    return new Promise<Response>((_resolve, reject) => {
      if (options?.signal?.aborted) reject(new Error('Aborted'));
      else options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  }) as typeof fetch;
  try {
    await bot.reconcile();
    for (let i = 0; i < 100 && !seen.includes(3); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, [3]);
    assert.equal(Object.values(store.state.offsets).length, 0);
    releaseFirst();
    for (let i = 0; i < 100 && !Object.values(store.state.offsets).includes(4); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, [3, 1, 2]);
    assert.ok(Object.values(store.state.offsets).includes(4));
  } finally {
    releaseFirst();
    await bot.stop();
    globalThis.fetch = original;
    await rm(store.dir, { recursive: true, force: true });
  }
});
test('API requires login, rejects cross-origin writes, masks keys and persists audience changes', async () => {
  const store = await tempStore();
  const audio = new AudioService();
  const bot = new TelegramBot(store, audio);
  store.config = configSchema.parse({ chatGptApiKey: 'sk-private-value' });
  store.state.chats['-1001'] = chat();
  const app = createApp(store, bot, audio, 'test-dashboard-password');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/bot/config`)).status, 401);
    const rejected = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.test' },
      body: JSON.stringify({ password: 'test-dashboard-password' }),
    });
    assert.equal(rejected.status, 403);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-dashboard-password' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
    const config = await (
      await fetch(`${base}/api/bot/config`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(config.config.credentials.chatGptApiKey, true);
    assert.ok(!JSON.stringify(config).includes('sk-private-value'));
    const updated = await fetch(`${base}/api/bot/audience/-1001`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'en-US', enabled: false }),
    });
    assert.equal(updated.status, 200);
    assert.equal(store.state.chats['-1001'].enabled, false);
    assert.equal(
      (
        await fetch(`${base}/api/bot/audience/__proto__`, {
          method: 'PATCH',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      400,
    );
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(
      (await fetch(`${base}/api/bot/config`, { headers: { Cookie: cookie } })).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(store.dir, { recursive: true, force: true });
  }
});

test('Telegram text, voice and video notes feed summaries and persist completed update offsets', async () => {
  const store = await tempStore();
  const original = globalThis.fetch;
  store.config = configSchema.parse({
    token: '123456:abcdefghijklmnopqrstuvwxyz',
    enabled: true,
    transcribeMode: 'fastapi',
    openRouterApiKey: 'sk-or-test',
  });
  const calls: { method: string; data: Record<string, unknown> }[] = [];
  let polled = false;
  let summaryInput = '';
  const base = {
    date: Math.floor(Date.now() / 1000),
    chat: { id: -1001, type: 'group', title: 'Team' },
    from: { id: 5, first_name: 'Sara' },
  };
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const address = String(url);
    if (address.includes('openrouter.ai')) {
      summaryInput = String(options?.body);
      return Response.json({
        choices: [{ message: { content: 'Team decided to meet tomorrow.' } }],
      });
    }
    if (address.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    const method = address.split('/').at(-1)!;
    const data = JSON.parse(String(options?.body || '{}'));
    calls.push({ method, data });
    let result: unknown;
    if (method === 'getMe') result = { id: 1, username: 'testbot', first_name: 'Test' };
    else if (method === 'getWebhookInfo') result = { url: '' };
    else if (method === 'getChatMemberCount') result = 7;
    else if (method === 'getFile') result = { file_path: 'voice/test.ogg' };
    else if (method === 'getUpdates') {
      if (polled)
        return new Promise<Response>((_resolve, reject) => {
          if (options?.signal?.aborted) reject(new Error('Aborted'));
          else
            options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
              once: true,
            });
        });
      polled = true;
      result = [
        { update_id: 10, message: { ...base, message_id: 1, text: 'We should meet tomorrow.' } },
        {
          update_id: 11,
          message: { ...base, message_id: 2, voice: { file_id: 'voice1', duration: 1 } },
        },
        {
          update_id: 12,
          message: { ...base, message_id: 3, video_note: { file_id: 'video1', duration: 1 } },
        },
        { update_id: 13, message: { ...base, message_id: 4, text: '/summary@testbot 50' } },
      ];
    } else result = { message_id: 900 };
    return Response.json({ ok: true, result });
  }) as typeof fetch;
  class TestAudio extends AudioService {
    override async process(
      _bytes: Buffer,
      _config: ReturnType<typeof configSchema.parse>,
      language = 'fa-IR',
    ) {
      return {
        text: 'Agreed, tomorrow at ten.',
        durationMs: 5,
        engine: 'fastapi' as const,
        language,
        audioSeconds: 1,
      };
    }
  }
  const bot = new TelegramBot(store, new TestAudio());
  try {
    await bot.reconcile();
    for (let i = 0; i < 200 && !Object.values(store.state.offsets).includes(14); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.state.chats['-1001'].history.length, 3);
    assert.equal(store.state.metrics.succeeded, 2);
    assert.equal(store.state.metrics.summaries, 1);
    assert.ok(summaryInput.includes('Agreed, tomorrow at ten.'));
    assert.ok(
      calls.some(
        (c) => c.method === 'editMessageText' && c.data.text === 'Team decided to meet tomorrow.',
      ),
    );
    assert.equal(
      calls.filter((c) => c.method === 'sendMessage' && c.data.text === 'Agreed, tomorrow at ten.')
        .length,
      2,
    );
    await bot.stop();
    const restored = new Store(store.dir);
    await restored.init();
    assert.ok(Object.values(restored.state.offsets).includes(14));
  } finally {
    await bot.stop();
    globalThis.fetch = original;
    await rm(store.dir, { recursive: true, force: true });
  }
});

test('custom summary API uses its configured endpoint, exact model and credential', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sk-custom-test');
    if (String(url).endsWith('/models'))
      return Response.json({ data: [{ id: 'cx/gpt-5.6-sol(low)' }] });
    assert.equal(JSON.parse(String(init?.body)).model, 'cx/gpt-5.6-sol(low)');
    return Response.json({ choices: [{ message: { content: 'Test summary' } }] });
  }) as typeof fetch;
  try {
    const config = configSchema.parse({
      llmBrain: 'chatgpt',
      chatGptBaseUrl: 'http://127.0.0.1:20128/v1/',
      chatGptApiKey: 'sk-custom-test',
      chatGptModel: 'cx/gpt-5.6-sol(low)',
    });
    await verifyOpenAI(config.chatGptApiKey, config.chatGptBaseUrl);
    const result = await summarize(config, [
      { messageId: 1, timestamp: Date.now(), sender: 'Test', text: 'A meeting tomorrow.' },
    ]);
    assert.equal(result.provider, 'Custom API');
    assert.equal(result.fallback, false);
    assert.deepEqual(requests, [
      'http://127.0.0.1:20128/v1/models',
      'http://127.0.0.1:20128/v1/chat/completions',
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
