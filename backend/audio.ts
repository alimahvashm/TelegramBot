import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../shared/config.js';
import { AppError } from './http.js';
import { transcribe } from './providers.js';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_SECONDS = 180;
const formats = 'ogg,mp3,mov,matroska,webm,wav,flac,aac';
function run(command: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-100000);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new AppError('FFmpeg / FFprobe is not installed or executable on the server.', 503));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new AppError(
            timedOut
              ? 'Audio conversion timed out.'
              : 'Audio could not be decoded. Upload a valid audio or video note.',
            422,
          ),
        );
    });
  });
}
export class AudioService {
  private active = 0;
  constructor(private log: (message: string) => void = () => {}) {}
  async process(bytes: Buffer, config: Config, language = config.language, includeWav = false) {
    if (!bytes.length || bytes.length > MAX_BYTES)
      throw new AppError('Audio must be between 1 byte and 20 MB.', 413);
    if (this.active >= 2) throw new AppError('Audio workers are busy. Try again shortly.', 429);
    this.active++;
    let dir: string | undefined;
    const started = Date.now();
    try {
      dir = await mkdtemp(path.join(tmpdir(), 'voice-studio-'));
      const source = path.join(dir, 'input');
      const wav = path.join(dir, 'voice.wav');
      const flac = path.join(dir, 'voice.flac');
      await writeFile(source, bytes, { mode: 0o600 });
      const metadata = JSON.parse(
        await run(
          process.env.FFPROBE_PATH || 'ffprobe',
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-format_whitelist',
            formats,
            '-show_entries',
            'format=duration',
            '-of',
            'json',
            source,
          ],
          15000,
        ),
      ) as { format?: { duration?: string } };
      const duration = Number(metadata.format?.duration);
      if (Number.isFinite(duration) && duration > MAX_SECONDS)
        throw new AppError(`Audio must be no longer than ${MAX_SECONDS / 60} minutes.`, 413);
      this.log('Converting audio to 16 kHz, 16-bit mono WAV.');
      await run(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        formats,
        '-i',
        source,
        '-map',
        '0:a:0',
        '-vn',
        '-t',
        String(MAX_SECONDS + 1),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-threads',
        '1',
        wav,
      ]);
      const wavData = await readFile(wav);
      if (wavData.length > MAX_SECONDS * 32000 + 4096)
        throw new AppError('Recording exceeds the 3-minute limit.', 413);
      if (config.transcribeMode === 'google_asr')
        await run(process.env.FFMPEG_PATH || 'ffmpeg', [
          '-nostdin',
          '-v',
          'error',
          '-i',
          wav,
          '-c:a',
          'flac',
          flac,
        ]);
      this.log(`Forwarding audio to ${config.transcribeMode}.`);
      const text = await transcribe(
        config,
        wav,
        config.transcribeMode === 'google_asr' ? flac : undefined,
        language,
      );
      const durationMs = Date.now() - started;
      this.log(`Transcription completed in ${(durationMs / 1000).toFixed(1)}s.`);
      return {
        text,
        durationMs,
        engine: config.transcribeMode,
        language,
        audioSeconds: Number.isFinite(duration)
          ? duration
          : Math.max(0, (wavData.length - 78) / 32000),
        ...(includeWav ? { wavBase64: wavData.toString('base64') } : {}),
      };
    } finally {
      this.active--;
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
}
