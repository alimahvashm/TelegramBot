import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../backend/store.js';
import { TelegramBot } from '../backend/telegram.js';
import { AudioService } from '../backend/audio.js';
import { configSchema } from '../shared/config.js';
import { answerEducationQuestion } from '../backend/providers.js';

test('replying to a generated PDF answers from persisted notes after restart', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'question-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = new Store(dir);
  await original.init();
  await original.saveEducationNotes('42', 100, 'عنوان درس\n\nفشار خون با دو عدد بیان می‌شود.');
  const store = new Store(dir);
  await store.init();
  store.config = configSchema.parse({ llmBrain: 'chatgpt', chatGptApiKey: 'test-key' });
  const bot = new TelegramBot(store, new AudioService());
  bot.status.bot = { id: 1, first_name: 'Test', username: 'testbot' };
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let modelCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (url.endsWith('/chat/completions')) {
      modelCalls++;
      const body = JSON.parse(String(options?.body));
      assert.match(body.messages[0].content, /فقط بر اساس جزوه/);
      assert.match(body.messages[1].content, /فشار خون/);
      assert.match(body.messages[1].content, /دو عدد/);
      return Response.json({ choices: [{ message: { content: 'فشار خون با دو عدد بیان می‌شود.' } }] });
    }
    const method = url.split('/').at(-1)!;
    const body = JSON.parse(String(options?.body));
    calls.push({ method, body });
    return Response.json({ ok: true, result: { message_id: 500 } });
  });
  const base = {
    message_id: 101,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 42, type: 'private' },
    from: { id: 2, first_name: 'User' },
    text: '/question@testbot فشار خون چگونه بیان می‌شود؟',
  };
  const pdf = { ...base, message_id: 100, from: { id: 1, first_name: 'Test' }, document: { file_name: 'education-notes.pdf' } };
  await bot['handle']('test-token', { ...base, reply_to_message: pdf }, store.config);
  assert.equal(modelCalls, 1);
  assert.ok(calls.some((call) => call.method === 'editMessageText' && call.body.text === 'فشار خون با دو عدد بیان می‌شود.'));
  await bot['handle']('test-token', { ...base, message_id: 102, chat: { id: 43, type: 'private' }, reply_to_message: pdf }, store.config);
  assert.equal(modelCalls, 1);
  assert.match(String(calls.at(-1)?.body.text), /ذخیره نشده/);
  await bot['handle']('test-token', { ...base, message_id: 103, reply_to_message: { ...pdf, from: { id: 3, first_name: 'Other' } } }, store.config);
  assert.equal(modelCalls, 1);
  assert.match(String(calls.at(-1)?.body.text), /این ربات/);
});

test('a question about a long PDF checks later sections instead of truncating them', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    calls++;
    const input = JSON.parse(String(options?.body)).messages[1].content as string;
    return Response.json({ choices: [{ message: {
      content: input.includes('پاسخ در پایان جزوه') ? 'پاسخ در پایان جزوه آمده است.' : 'NO_ANSWER',
    } }] });
  });
  const result = await answerEducationQuestion(
    configSchema.parse({ llmBrain: 'chatgpt', chatGptApiKey: 'test-key' }),
    'متن آموزشی '.repeat(5000) + 'پاسخ در پایان جزوه',
    'پاسخ کجاست؟',
  );
  assert.ok(calls > 2);
  assert.match(result.text, /پایان جزوه/);
});
