import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../backend/store.js';
import { AudioService } from '../backend/audio.js';
import { TelegramBot } from '../backend/telegram.js';
import { AppError } from '../backend/http.js';
import { configSchema } from '../shared/config.js';
import { createEducationNotes } from '../backend/providers.js';
import { educationHtml } from '../backend/education-pdf.js';

test('education uses the configured model and keeps the complete lecture separate from instructions', async (t) => {
  const transcript = 'متن تدریس '.repeat(500) + 'نکتهٔ پایانی';
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://router.example/v1/chat/completions');
    const body = JSON.parse(String(options.body));
    assert.equal(body.model, 'cx/gpt-6-luna');
    assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer test-key');
    assert.match(body.messages[0].content, /نیاز به توضیح بیشتر/);
    assert.match(body.messages[0].content, /اضافه نکن/);
    assert.ok(body.messages[1].content.includes(JSON.stringify(transcript)));
    assert.equal(body.max_tokens, 6000);
    return Response.json({ choices: [{ message: { content: '📚 جزوه\n\nتوضیح ساده' } }] });
  });
  const result = await createEducationNotes(
    configSchema.parse({
      llmBrain: 'chatgpt',
      chatGptBaseUrl: 'https://router.example/v1',
      chatGptApiKey: 'test-key',
      chatGptModel: 'cx/gpt-6-luna',
    }),
    transcript,
  );
  assert.equal(result.text, '📚 جزوه\n\nتوضیح ساده');
  await assert.rejects(createEducationNotes(configSchema.parse({}), ''), /No lecture transcript/);
});

test('education uses a saved custom prompt for every lecture section', async (t) => {
  const systems: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    systems.push(JSON.parse(String(options.body)).messages[0].content);
    return Response.json({ choices: [{ message: { content: 'جزوهٔ درس' } }] });
  });
  await createEducationNotes(
    configSchema.parse({
      llmBrain: 'chatgpt',
      chatGptApiKey: 'test-key',
      educationSystemPrompt: 'راهنمای اختصاصی جزوه‌نویسی',
    }),
    'متن درس '.repeat(1800),
  );
  assert.ok(systems.length > 1);
  assert.ok(systems.every((system) => system.includes('راهنمای اختصاصی جزوه‌نویسی')));
});

test('reply education transcribes the target, delivers long notes, enforces limits and reports failures', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'education-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.init();
  store.config = configSchema.parse({
    autoReply: false,
    llmBrain: 'chatgpt',
    chatGptApiKey: 'test-key',
  });
  const audio = new AudioService();
  const transcript = 'متن کامل استاد';
  const audioMock = t.mock.method(audio, 'process', async (_bytes, _config, language) => {
    assert.equal(language, 'fa-IR');
    return {
      text: transcript,
      durationMs: 1,
      engine: 'google_asr' as const,
      language: 'fa-IR',
      audioSeconds: 1,
    };
  });
  const calls: { method: string; body: Record<string, any> }[] = [];
  const notes = '📚 جزوه\n\n' + 'نکتهٔ مهم\n'.repeat(900);
  let modelCalls = 0;
  let failModel = false;
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    if (url.endsWith('/chat/completions')) {
      modelCalls++;
      assert.ok(String(options?.body).includes(transcript));
      return failModel
        ? new Response('{}', { status: 401 })
        : Response.json({ choices: [{ message: { content: notes } }] });
    }
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    if (url.endsWith('/sendDocument')) {
      const form = options?.body as FormData;
      const document = form.get('document') as File;
      assert.equal(document.name, 'education-notes.pdf');
      assert.equal(document.type, 'application/pdf');
      assert.equal(Buffer.from(await document.arrayBuffer()).toString(), '%PDF-test');
      assert.equal(JSON.parse(String(form.get('reply_parameters'))).message_id, 20);
      calls.push({ method: 'sendDocument', body: { document: document.name } });
      return Response.json({ ok: true, result: { message_id: 901 } });
    }
    const method = url.split('/').at(-1)!;
    const body = JSON.parse(String(options?.body));
    calls.push({ method, body });
    return Response.json({
      ok: true,
      result: method === 'getFile' ? { file_path: 'voice/target.ogg' } : { message_id: 900 },
    });
  });
  const pdfInputs: string[] = [];
  const bot = new TelegramBot(store, audio, async (text) => {
    pdfInputs.push(text);
    return Buffer.from('%PDF-test');
  });
  bot.status.bot = { id: 1, first_name: 'Test', username: 'testbot' };
  const base = {
    message_id: 20,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: 'private' },
    from: { id: 5, first_name: 'User' },
  };
  const voice = { ...base, message_id: 10, voice: { file_id: 'target-voice', duration: 2 } };
  const handle = async (id: number, extra = {}) =>
    bot['handle'](
      'test-token',
      {
        ...base,
        chat: { ...base.chat, id },
        text: '/education@testbot',
        reply_to_message: voice,
        ...extra,
      },
      store.config,
    );
  await handle(1, { reply_to_message: undefined });
  assert.equal(modelCalls, 0);
  assert.match(String(calls.at(-1)?.body.text), /ریپلای/);
  calls.length = 0;
  await handle(2);
  assert.equal(audioMock.mock.callCount(), 1);
  assert.equal(modelCalls, 1);
  assert.equal(calls.find((c) => c.method === 'getFile')?.body.file_id, 'target-voice');
  assert.deepEqual(pdfInputs, [notes.trim()]);
  assert.equal(calls.filter((c) => c.method === 'sendDocument').length, 1);
  assert.match(String(calls.at(-1)?.body.text), /PDF ارسال شد/);
  await handle(2);
  assert.equal(modelCalls, 1);
  assert.equal(pdfInputs.length, 1);
  assert.match(String(calls.at(-1)?.body.text), /۳۰ ثانیه/);
  await handle(3, { reply_to_message: { ...voice, voice: { file_id: 'large', duration: 3601 } } });
  assert.equal(audioMock.mock.callCount(), 1);
  assert.match(String(calls.at(-1)?.body.text), /۶۰ دقیقه/);
  failModel = true;
  await handle(4);
  assert.match(String(calls.at(-1)?.body.text), /سهمیه/);
  audioMock.mock.mockImplementation(async () => {
    throw new AppError('No speech', 422);
  });
  await handle(5);
  assert.match(String(calls.at(-1)?.body.text), /گفتار واضحی/);
  assert.equal(modelCalls, 2);
  assert.equal(pdfInputs.length, 1);
  store.state.chats['2'].enabled = false;
  const count = calls.length;
  await handle(2);
  assert.equal(calls.length, count);
  await handle(6, { text: '/education@otherbot' });
  assert.equal(modelCalls, 2);
});

test('education PDF markup escapes model text and uses B Nazanin with bold RTL headings', () => {
  const html = educationHtml('عنوان درس\n\nنکتهٔ اصلی\n\nمتن <script>alert(1)</script> و & بیشتر.');
  assert.match(html, /<html lang="fa" dir="rtl">/);
  assert.match(html, /<h1>عنوان درس<\/h1>/);
  assert.match(html, /<h2>نکتهٔ اصلی<\/h2>/);
  assert.match(html, /font-weight: 700/);
  assert.match(html, /font: 14pt\/1\.75 'B Nazanin'/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; و &amp; بیشتر/);
  assert.doesNotMatch(html, /<script>/);
});

test('long lecture notes cover every section without a final truncating summary', async (t) => {
  const input = 'موضوع درس و توضیحات استاد.\n'.repeat(2400) + 'پایان تدریس';
  const received: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(String(options.body));
    received.push(JSON.parse(body.messages[1].content.split('\n').slice(1).join('\n')));
    return Response.json({ choices: [{ message: { content: `notes ${received.length}` } }] });
  });
  const result = await createEducationNotes(
    configSchema.parse({ llmBrain: 'chatgpt', chatGptApiKey: 'test-key' }),
    input,
  );
  assert.equal(received.join(''), input);
  assert.ok(received.length > 3);
  assert.ok(received.every((s) => s.length <= 12001));
  assert.ok(result.text.endsWith(`notes ${received.length}`));
});
