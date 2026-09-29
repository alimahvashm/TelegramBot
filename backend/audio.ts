import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../shared/config.js';
import { AppError } from './http.js';
import { transcribe } from './providers.js';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_SECONDS = 3600;
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
  async process(
    bytes: Buffer,
    config: Config,
    language = config.language,
    includeWav = false,
    progress?: (done: number, total: number) => Promise<void>,
  ) {
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
      let duration = Number(metadata.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        const scan = await run(process.env.FFMPEG_PATH || 'ffmpeg', [
          '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-format_whitelist', formats, '-i', source, '-map', '0:a:0', '-vn',
          '-t', String(MAX_SECONDS + 1), '-progress', 'pipe:1', '-f', 'null', '-',
        ], 120000);
        const times = [...scan.matchAll(/out_time_us=(\d+)/g)];
        duration = Number(times.at(-1)?.[1]) / 1000000;
      }
      if (!Number.isFinite(duration) || duration <= 0)
        throw new AppError(
          'Audio duration could not be determined. Please send OGG, MP3 or WAV audio.',
          422,
        );
      if (duration > MAX_SECONDS)
        throw new AppError(`Audio must be no longer than ${MAX_SECONDS / 60} minutes.`, 413);
      const segmentSeconds = 60;
      const total = Math.ceil(duration / segmentSeconds);
      const transcripts: string[] = [];
      let downloadableWav: Buffer | undefined;
      for (let index = 0; index < total; index++) {
        await progress?.(index, total);
        this.log(`Transcribing audio segment ${index + 1}/${total}.`);
        await run(process.env.FFMPEG_PATH || 'ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-protocol_whitelist',
          'file,pipe',
          '-format_whitelist',
          formats,
          '-ss',
          String(index * segmentSeconds),
          '-i',
          source,
          '-map',
          '0:a:0',
          '-vn',
          '-t',
          String(Math.min(segmentSeconds, duration - index * segmentSeconds)),
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
        if (config.transcribeMode === 'google_asr')
          await run(process.env.FFMPEG_PATH || 'ffmpeg', [
            '-y',
            '-nostdin',
            '-v',
            'error',
            '-i',
            wav,
            '-c:a',
            'flac',
            flac,
          ]);
        try {
          transcripts.push(
            await transcribe(
              config,
              wav,
              config.transcribeMode === 'google_asr' ? flac : undefined,
              language,
            ),
          );
        } catch (error) {
          if (error instanceof AppError && error.status === 422) {
            // Keep the gap visible rather than silently claiming a complete transcript.
            transcripts.push(
              `[گفتار قابل تشخیص نبود: ثانیهٔ ${index * segmentSeconds} تا ${Math.min(duration, (index + 1) * segmentSeconds)}]`,
            );
          } else {
            throw new AppError(
              `Transcription failed at segment ${index + 1}/${total}. Please retry; no partial transcript was returned.`,
              502,
            );
          }
        }
        if (includeWav && total === 1) downloadableWav = await readFile(wav);
      }
      if (transcripts.every((part) => part.startsWith('[گفتار قابل تشخیص نبود:')))
        throw new AppError('No speech was recognized. Try a clearer recording.', 422);
      const text = transcripts.join('\n\n');
      await progress?.(total, total);
      const durationMs = Date.now() - started;
      this.log(`Transcription completed in ${(durationMs / 1000).toFixed(1)}s.`);
      return {
        text,
        durationMs,
        engine: config.transcribeMode,
        language,
        audioSeconds: duration,
        segments: total,
        ...(downloadableWav ? { wavBase64: downloadableWav.toString('base64') } : {}),
      };
    } finally {
      this.active--;
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
}
