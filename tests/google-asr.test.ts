import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transcribe } from '../backend/providers.js';
import { configSchema } from '../shared/config.js';
import { AppError } from '../backend/http.js';

test('Google ASR matches Python protocol, supports overrides and handles provider responses', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'google-asr-test-'));
  const audio = path.join(dir, 'audio');
  await writeFile(audio, 'fixture');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = configSchema.parse({});
  let calls = 0;
  const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.searchParams.get('client'), 'chromium');
    assert.equal(url.searchParams.get('pFilter'), '0');
    assert.equal(url.searchParams.get('lang'), 'fa-IR');
    assert.ok(url.searchParams.get('key'));
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'audio/x-flac; rate=16000');
    assert.equal(Buffer.from(init.body as Buffer).toString(), 'fixture');
    if (++calls === 1) return new Response('', { status: 429 });
    return new Response('\n{"result":[]}\n{"result":[{"alternative":[{"transcript":"سلام دنیا"},{"transcript":"ignored"}]}]}\n');
  });
  assert.equal(await transcribe(config, audio, audio, 'fa-IR'), 'سلام دنیا');
  assert.equal(calls, 2);
  mock.mock.mockImplementation(async (input) => {
    assert.equal(new URL(input).searchParams.get('key'), 'custom-key');
    return new Response('{"result":[]}\n');
  });
  await assert.rejects(transcribe({ ...config, googleSpeechApiKey: 'custom-key' }, audio, audio, 'en-US'),
    (error: unknown) => error instanceof AppError && error.status === 422);
  mock.mock.mockImplementation(async () => new Response('invalid-json'));
  await assert.rejects(transcribe(config, audio, audio, 'en-US'),
    (error: unknown) => error instanceof AppError && error.status === 502);
});
