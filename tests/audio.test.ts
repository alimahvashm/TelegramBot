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
  'undecodable input and recordings over three minutes are rejected before provider use',
  { skip: !available && 'Install FFmpeg and FFprobe to run audio integration tests.' },
  async () => {
    const service = new AudioService();
    const config = configSchema.parse({ transcribeMode: 'fastapi' });
    await assert.rejects(
      service.process(Buffer.from('not valid media'), config),
      /could not be decoded/,
    );
    await assert.rejects(service.process(wav(181), config), /no longer than 3 minutes/);
  },
);
