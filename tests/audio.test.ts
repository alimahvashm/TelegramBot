import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { AudioService } from '../backend/audio.js';
import { configSchema } from '../shared/config.js';

function wav(seconds: number) {
  const rate = 44100,
    size = seconds * rate * 2;
  const buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(size, 40);
  for (let i = 0; i < size / 2; i++)
    buffer.writeInt16LE(Math.round(Math.sin((i / rate) * Math.PI * 880) * 5000), 44 + i * 2);
  return buffer;
}
let available = true;
try {
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  available = false;
}
test(
  'real FFmpeg resamples WAV and FastAPI receives 16-bit mono 16 kHz audio',
  { skip: !available && 'Install FFmpeg and FFprobe to run audio integration tests.' },
  async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, options?: RequestInit) => {
      const form = options?.body as FormData;
      const file = form.get('file') as File;
      const converted = Buffer.from(await file.arrayBuffer());
      assert.equal(converted.toString('ascii', 0, 4), 'RIFF');
      assert.equal(converted.readUInt16LE(22), 1);
      assert.equal(converted.readUInt32LE(24), 16000);
      assert.equal(converted.readUInt16LE(34), 16);
      assert.equal(form.get('language'), 'fa-IR');
      return Response.json({ text: 'متن آزمایشی' });
    }) as typeof fetch;
    try {
      const result = await new AudioService().process(
        wav(1),
        configSchema.parse({ transcribeMode: 'fastapi' }),
        'fa-IR',
        true,
      );
      assert.equal(result.text, 'متن آزمایشی');
      assert.equal(result.audioSeconds, 1);
      assert.ok(result.wavBase64);
    } finally {
      globalThis.fetch = original;
    }
  },
);
test(
  'undecodable input is rejected before provider use',
  { skip: !available && 'Install FFmpeg and FFprobe to run audio integration tests.' },
  async () => {
    const service = new AudioService();
    const config = configSchema.parse({ transcribeMode: 'fastapi' });
    await assert.rejects(
      service.process(Buffer.from('not valid media'), config),
      /could not be decoded/,
    );
  },
);

test(
  'a real 50-minute compressed recording is transcribed in ordered bounded segments',
  { skip: !available },
  async (t) => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(tmpdir() + '/long-audio-');
    t.after(() => rm(dir, { recursive: true, force: true }));
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-t',
      '3000',
      '-c:a',
      'flac',
      dir + '/long.flac',
    ]);
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const file = (init.body as FormData).get('file') as File;
      assert.ok(file.size <= 60 * 32000 + 4096);
      return Response.json({ text: `section ${++calls}` });
    });
    const result = await new AudioService().process(
      await readFile(dir + '/long.flac'),
      configSchema.parse({ transcribeMode: 'fastapi' }),
    );
    assert.equal(calls, 50);
    assert.equal(result.audioSeconds, 3000);
    assert.equal(result.text.split('\n\n').length, 50);
    assert.ok(result.text.endsWith('section 50'));
    assert.equal(result.wavBase64, undefined);
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3601', '-c:a', 'flac', dir + '/too-long.flac']);
    await assert.rejects(new AudioService().process(await readFile(dir + '/too-long.flac'), configSchema.parse({transcribeMode:'fastapi'})), /no longer than 60 minutes/);
    assert.equal(calls, 50);

  },
);

test('unrecognized segments are marked and failed provider calls never return partial audio', {skip: !available}, async (t) => {
 let calls = 0;
 const mock = t.mock.method(globalThis, 'fetch', async () => {
   calls++;
   return Response.json({text: calls === 2 ? '' : `speech ${calls}`});
 });
 const service = new AudioService();
 const config = configSchema.parse({transcribeMode:'fastapi'});
 const result = await service.process(wav(121), config);
 assert.equal(calls, 3);
 assert.match(result.text, /speech 1/);
 assert.match(result.text, /گفتار قابل تشخیص نبود/);
 assert.match(result.text, /speech 3/);
 calls = 0;
 mock.mock.mockImplementation(async () => ++calls === 1 ? Response.json({text:'first'}) : new Response('{}',{status:401}));
 await assert.rejects(service.process(wav(121), config), /failed at segment 2\/3/);
});
