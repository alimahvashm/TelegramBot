import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../backend/store.js';
import { TelegramBot } from '../backend/telegram.js';
import { AudioService } from '../backend/audio.js';
import { configSchema } from '../shared/config.js';

test('photo caption and follow-up photo update the replied Education PDF and its saved notes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.init();
  await store.saveEducationNotes('42', 100, 'جزوهٔ اصلی');
  store.config = configSchema.parse({ llmBrain: 'chatgpt', chatGptApiKey: 'test-key' });
  const rendered: string[] = [];
  const bot = new TelegramBot(store, new AudioService(), async (notes) => {
    rendered.push(notes);
    return Buffer.from('%PDF-test');
  });
  bot.status.bot = { id: 1, first_name: 'Test', username: 'testbot' };
  const calls: string[] = [];
  let visionCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (url.includes('/file/bot')) return new Response(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    if (url.endsWith('/chat/completions')) {
      visionCalls++;
      const body = JSON.parse(String(options?.body));
      assert.equal(body.messages[1].content[1].type, 'image_url');
      assert.match(body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
      return Response.json({ choices: [{ message: { content: `نکتهٔ تصویری ${visionCalls}` } }] });
    }
    const method = url.split('/').at(-1)!;
    calls.push(method);
    if (method === 'editMessageMedia') {
      const form = options?.body as FormData;
      assert.equal(JSON.parse(String(form.get('media'))).media, 'attach://document');
      assert.equal(form.get('message_id'), '100');
      assert.equal((form.get('document') as File).name, 'education-notes.pdf');
    }
    return Response.json({ ok: true, result: method === 'getFile' ? { file_path: 'photo/test.jpg' } : { message_id: 500 } });
  });
  const base = {
    message_id: 101,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 42, type: 'private' },
    from: { id: 2, first_name: 'User' },
  };
  const pdf = { ...base, message_id: 100, from: { id: 1, first_name: 'Test' }, document: { file_name: 'education-notes.pdf' } };
  await bot['handle']('test-token', {
    ...base,
    caption: '/image@testbot',
    photo: [{ file_id: 'photo1' }],
    reply_to_message: pdf,
  }, store.config);
  assert.equal(visionCalls, 1);
  assert.equal(calls.filter((method) => method === 'editMessageMedia').length, 1);
  assert.match((await store.readEducationNotes('42', 100))!, /نکتهٔ تصویری 1/);
  await bot['handle']('test-token', { ...base, message_id: 102, text: '/image', reply_to_message: pdf }, store.config);
  await bot['handle']('test-token', { ...base, message_id: 103, photo: [{ file_id: 'photo2' }] }, store.config);
  assert.equal(visionCalls, 2);
  assert.equal(calls.filter((method) => method === 'editMessageMedia').length, 2);
  assert.match(rendered.at(-1)!, /نکتهٔ تصویری 1[\s\S]*نکتهٔ تصویری 2/);
  assert.equal((await store.readEducationNotes('42', 100))!, rendered.at(-1));
});

test('when Telegram cannot edit the original PDF, a new PDF is sent and both document IDs retain updated notes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-fallback-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.init();
  await store.saveEducationNotes('42', 100, 'جزوهٔ اصلی');
  store.config = configSchema.parse({ llmBrain: 'chatgpt', chatGptApiKey: 'test-key' });
  const bot = new TelegramBot(store, new AudioService(), async () => Buffer.from('%PDF-test'));
  bot.status.bot = { id: 1, first_name: 'Test', username: 'testbot' };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/file/bot')) return new Response(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    if (url.endsWith('/chat/completions'))
      return Response.json({ choices: [{ message: { content: 'نکتهٔ تکمیلی' } }] });
    if (url.endsWith('/editMessageMedia')) return new Response('{}', { status: 400 });
    const method = url.split('/').at(-1)!;
    return Response.json({ ok: true, result: method === 'getFile' ? { file_path: 'photo/test.jpg' } : { message_id: 501 } });
  });
  const base = {
    message_id: 101,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 42, type: 'private' },
    from: { id: 2, first_name: 'User' },
  };
  await bot['handle']('test-token', {
    ...base,
    caption: '/image',
    photo: [{ file_id: 'photo' }],
    reply_to_message: {
      ...base,
      message_id: 100,
      from: { id: 1, first_name: 'Test' },
      document: { file_name: 'education-notes.pdf' },
    },
  }, store.config);
  assert.match((await store.readEducationNotes('42', 100))!, /نکتهٔ تکمیلی/);
  assert.equal(await store.readEducationNotes('42', 501), await store.readEducationNotes('42', 100));
});
