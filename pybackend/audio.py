"""Bounded FFmpeg conversion and sequential minute-sized transcription."""
import asyncio
import base64
import json
import math
import os
import re
import tempfile
import time
from pathlib import Path
from .errors import AppError
from .providers import transcribe, polish_transcript

MAX_BYTES = 20 * 1024 * 1024
MAX_SECONDS = 3600
FORMATS = 'ogg,mp3,mov,matroska,webm,wav,flac,aac'

async def run(command: str, args: list[str], timeout: int = 60) -> str:
    try:
        process = await asyncio.create_subprocess_exec(command, *args,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
    except OSError:
        raise AppError('FFmpeg / FFprobe is not installed or executable on the server.', 503)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise AppError('Audio conversion timed out.', 422)
    if process.returncode:
        raise AppError('Audio could not be decoded. Upload a valid audio or video note.', 422)
    return stdout[-100000:].decode(errors='replace')

class AudioService:
    def __init__(self, log=lambda message: None):
        self.active = 0
        self.log = log

    async def process(self, data: bytes, config: dict, language: str | None = None,
                      include_wav: bool = False, progress=None):
        if not data or len(data) > MAX_BYTES:
            raise AppError('Audio must be between 1 byte and 20 MB.', 413)
        if self.active >= 2:
            raise AppError('Audio workers are busy. Try again shortly.', 429)
        self.active += 1
        started = time.monotonic()
        try:
            with tempfile.TemporaryDirectory(prefix='voice-studio-') as directory:
                root = Path(directory)
                source, wav, flac = root / 'input', root / 'voice.wav', root / 'voice.flac'
                source.write_bytes(data)
                os.chmod(source, 0o600)
                metadata = json.loads(await run(os.getenv('FFPROBE_PATH', 'ffprobe'), [
                    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS,
                    '-show_entries', 'format=duration', '-of', 'json', str(source)], 15))
                try:
                    duration = float(metadata.get('format', {}).get('duration', 'nan'))
                except (ValueError, TypeError):
                    duration = float('nan')
                if not math.isfinite(duration) or duration <= 0:
                    scan = await run(os.getenv('FFMPEG_PATH', 'ffmpeg'), [
                        '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                        '-format_whitelist', FORMATS, '-i', str(source), '-map', '0:a:0', '-vn',
                        '-t', str(MAX_SECONDS + 1), '-progress', 'pipe:1', '-f', 'null', '-'], 120)
                    times = re.findall(r'out_time_us=(\d+)', scan)
                    duration = int(times[-1]) / 1000000 if times else float('nan')
                if not math.isfinite(duration) or duration <= 0:
                    raise AppError('Audio duration could not be determined. Please send OGG, MP3 or WAV audio.', 422)
                if duration > MAX_SECONDS:
                    raise AppError('Audio must be no longer than 60 minutes.', 413)
                total = math.ceil(duration / 60)
                transcripts = []
                downloadable = None
                for index in range(total):
                    if progress:
                        await progress(index, total)
                    self.log(f'Transcribing audio segment {index + 1}/{total}.')
                    await run(os.getenv('FFMPEG_PATH', 'ffmpeg'), [
                        '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
                        '-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS,
                        '-ss', str(index * 60), '-i', str(source), '-map', '0:a:0', '-vn',
                        '-t', str(min(60, duration - index * 60)), '-ac', '1', '-ar', '16000',
                        '-c:a', 'pcm_s16le', '-threads', '1', str(wav)])
                    if config['transcribeMode'] == 'google_asr':
                        await run(os.getenv('FFMPEG_PATH', 'ffmpeg'), [
                            '-y', '-nostdin', '-v', 'error', '-i', str(wav), '-c:a', 'flac', str(flac)])
                    try:
                        transcripts.append(await transcribe(config, wav,
                            flac if config['transcribeMode'] == 'google_asr' else None,
                            language or config['language']))
                    except AppError as exc:
                        if exc.status == 422:
                            transcripts.append(f'[گفتار قابل تشخیص نبود: ثانیهٔ {index * 60} تا {min(duration, (index + 1) * 60)}]')
                        else:
                            raise AppError(f'Transcription failed at segment {index + 1}/{total}. Please retry; no partial transcript was returned.', 502)
                    if include_wav and total == 1:
                        downloadable = base64.b64encode(wav.read_bytes()).decode()
                if all(part.startswith('[گفتار قابل تشخیص نبود:') for part in transcripts):
                    raise AppError('No speech was recognized. Try a clearer recording.', 422)
                if progress:
                    await progress(total, total)
                raw_text = '\n\n'.join(transcripts)
                text = await polish_transcript(config, raw_text, self.log)
                duration_ms = int((time.monotonic() - started) * 1000)
                self.log(f'Transcription completed in {duration_ms / 1000:.1f}s.')
                result = {'text': text, 'durationMs': duration_ms,
                          'engine': config['transcribeMode'], 'language': language or config['language'],
                          'audioSeconds': duration, 'segments': total}
                if downloadable:
                    result['wavBase64'] = downloadable
                return result
        finally:
            self.active -= 1
