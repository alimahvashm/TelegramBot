import { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Check,
  Copy,
  Download,
  FileAudio,
  LoaderCircle,
  Mic,
  Square,
  Upload,
  X,
} from 'lucide-react';
import { api } from './api';

type Result = {
  text: string;
  durationMs: number;
  engine: string;
  language: string;
  audioSeconds: number;
  wavBase64?: string;
};
function spectrum(samples: Float32Array): number[] {
  const size = 512;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let i = 0; i < size; i++)
    real[i] = (samples[i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let i = 0; i < size; i += length) {
      for (let j = 0; j < length / 2; j++) {
        const cos = Math.cos(angle * j),
          sin = Math.sin(angle * j),
          a = i + j,
          b = a + length / 2;
        const tr = real[b] * cos - imaginary[b] * sin,
          ti = real[b] * sin + imaginary[b] * cos;
        real[b] = real[a] - tr;
        imaginary[b] = imaginary[a] - ti;
        real[a] += tr;
        imaginary[a] += ti;
      }
    }
  }
  return Array.from({ length: 128 }, (_, i) =>
    Math.min(
      1,
      Math.max(
        0,
        (20 * Math.log10(Math.hypot(real[i + 1], imaginary[i + 1]) / size + 1e-8) + 85) / 70,
      ),
    ),
  );
}
function Spectrogram({ file }: { file: File }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const context = new AudioContext();
    void file
      .arrayBuffer()
      .then((buffer) => context.decodeAudioData(buffer))
      .then((audio) => {
        if (cancelled || !canvas.current) return;
        const ctx = canvas.current.getContext('2d')!;
        const data = audio.getChannelData(0);
        const width = 360,
          height = 128;
        const pixels = ctx.createImageData(width, height);
        for (let x = 0; x < width; x++) {
          const start = Math.floor((x / width) * Math.max(0, data.length - 512));
          const frequencies = spectrum(data.subarray(start, start + 512));
          for (let y = 0; y < height; y++) {
            const strength = frequencies[y];
            const index = ((height - 1 - y) * width + x) * 4;
            pixels.data[index] = 20 + strength * 205;
            pixels.data[index + 1] = 31 + strength * 132;
            pixels.data[index + 2] = 53 + strength * 79;
            pixels.data[index + 3] = 255;
          }
        }
        ctx.putImageData(pixels, 0, 0);
      })
      .catch(() => {
        if (!cancelled)
          setError('Preview unavailable for this format. The server can still attempt conversion.');
      })
      .finally(() => {
        void context.close();
      });
    return () => {
      cancelled = true;
    };
  }, [file]);
  return (
    <div className="spectrum">
      <div className="flex justify-between text-xs mb-3 text-slate-400">
        <span>FREQUENCY SPECTRUM</span>
        <span>Time →</span>
      </div>
      <canvas ref={canvas} width={360} height={128} aria-label="Audio frequency spectrogram" />
      {error && <p className="text-xs text-slate-400 mt-2">{error}</p>}
    </div>
  );
}
export default function AudioLab({
  language: initialLanguage,
  onComplete,
}: {
  language: string;
  onComplete: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [wavUrl, setWavUrl] = useState('');
  const [language, setLanguage] = useState(initialLanguage);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [openingMic, setOpeningMic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const waveform = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const audioContext = useRef<AudioContext | null>(null);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recorder.current?.state === 'recording' && recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(frame.current);
      void audioContext.current?.close().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!file) {
      setUrl('');
      return;
    }
    const object = URL.createObjectURL(file);
    setUrl(object);
    return () => URL.revokeObjectURL(object);
  }, [file]);
  useEffect(() => {
    if (!result?.wavBase64) {
      setWavUrl('');
      return;
    }
    const bytes = Uint8Array.from(atob(result.wavBase64), (c) => c.charCodeAt(0));
    const object = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    setWavUrl(object);
    return () => URL.revokeObjectURL(object);
  }, [result]);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (recording && seconds >= 3600) recorder.current?.stop();
  }, [seconds, recording]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const choose = (next: File) => {
    if (next.size > 20 * 1024 * 1024) {
      setError('Choose a file smaller than 20 MB.');
      return;
    }
    setFile(next);
    setResult(null);
    setError('');
  };
  const record = async () => {
    setError('');
    setOpeningMic(true);
    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          'Microphone recording requires HTTPS or localhost and a supported browser.',
        );
      const request = navigator.mediaDevices.getUserMedia({ audio: true }).then((media) => {
        if (expired || !mounted.current) media.getTracks().forEach((t) => t.stop());
        return media;
      });
      stream.current = await Promise.race([
        request,
        new Promise<MediaStream>((_resolve, reject) => {
          timeout = setTimeout(() => {
            expired = true;
            reject(
              new Error('Microphone access timed out. Check browser permissions and try again.'),
            );
          }, 20000);
        }),
      ]);
      if (!mounted.current) {
        stream.current.getTracks().forEach((t) => t.stop());
        return;
      }
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      recorder.current = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
      const recordingMime = recorder.current.mimeType;
      const pieces: BlobPart[] = [];
      recorder.current.ondataavailable = (event) => {
        if (event.data.size) pieces.push(event.data);
      };
      recorder.current.onstop = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(frame.current);
        void audioContext.current?.close().catch(() => {});
        audioContext.current = null;
        if (mounted.current) {
          choose(
            new File(
              pieces,
              `recording.${recordingMime.includes('mp4') ? 'm4a' : recordingMime.includes('ogg') ? 'ogg' : 'webm'}`,
              { type: recordingMime },
            ),
          );
          setRecording(false);
        }
      };
      recorder.current.onerror = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setError('Recording failed. Check microphone permissions and try again.');
      };
      audioContext.current = new AudioContext();
      const analyser = audioContext.current.createAnalyser();
      analyser.fftSize = 256;
      audioContext.current.createMediaStreamSource(stream.current).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteTimeDomainData(samples);
        const ctx = waveform.current?.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, 500, 80);
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#f0785b';
          ctx.beginPath();
          samples.forEach((value, i) => {
            const x = (i / samples.length) * 500,
              y = (value / 255) * 80;
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          });
          ctx.stroke();
        }
        frame.current = requestAnimationFrame(draw);
      };
      recorder.current.start(500);
      setSeconds(0);
      setRecording(true);
      draw();
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(frame.current);
      void audioContext.current?.close().catch(() => {});
      audioContext.current = null;
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (mounted.current) setOpeningMic(false);
    }
  };
  const convert = async () => {
    if (!file) return;
    setBusy(true);
    setElapsed(0);
    setResult(null);
    setError('');
    const body = new FormData();
    body.append('audio', file);
    body.append('language', language);
    try {
      setResult(await api<Result>('/api/transcode', { method: 'POST', body }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onComplete();
    }
  };
  return (
    <div className="audio-grid">
      <section className="card">
        <div className="card-heading">
          <span className="icon-box peach">
            <AudioLines size={20} />
          </span>
          <div>
            <h2>Audio playground</h2>
            <p>A quick sound check for your bot.</p>
          </div>
        </div>
        <button
          className="dropzone"
          disabled={busy || recording}
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy && !recording && e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]);
          }}
        >
          <span className="upload-icon">
            <Upload size={26} />
          </span>
          <strong>Drop your audio here</strong>
          <span>or click to browse files</span>
          <small>OGG, MP3, M4A, WAV, WEBM · up to 20 MB / 60 min</small>
        </button>
        <input
          aria-label="Upload audio file"
          ref={input}
          type="file"
          accept="audio/*,video/mp4,video/webm,.ogg,.m4a,.flac"
          hidden
          onChange={(e) => {
            if (e.target.files?.[0]) choose(e.target.files[0]);
            e.target.value = '';
          }}
        />
        <div className="or">
          <span />
          OR RECORD SOMETHING
          <span />
        </div>
        <div className={`recorder ${recording ? 'is-recording' : ''}`}>
          <canvas ref={waveform} width={500} height={80} aria-label="Live microphone waveform" />
          <div className="flex items-center justify-between">
            <div>
              <strong>
                {recording ? 'Listening to your microphone' : 'Your voice, in writing'}
              </strong>
              <p>
                {recording
                  ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} / 3:00`
                  : openingMic
                    ? 'Opening microphone…'
                    : 'Record directly from your browser'}
              </p>
            </div>
            <button
              className={recording ? 'button danger' : 'button secondary'}
              disabled={busy || openingMic}
              onClick={recording ? () => recorder.current?.stop() : () => void record()}
            >
              {recording ? (
                <Square size={16} />
              ) : openingMic ? (
                <LoaderCircle size={16} className="animate-spin" />
              ) : (
                <Mic size={16} />
              )}
              {recording ? 'Stop' : 'Record'}
            </button>
          </div>
        </div>
        {file && (
          <div className="file-row">
            <FileAudio size={22} />
            <div>
              <strong>{file.name}</strong>
              <small>{(file.size / 1024 / 1024).toFixed(2)} MB</small>
            </div>
            <button
              className="icon-button"
              aria-label="Remove audio"
              disabled={busy || recording}
              onClick={() => {
                setFile(null);
                setResult(null);
              }}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {url && <audio controls src={url} className="w-full mt-4" />}
        <div className="mt-6">
          <label htmlFor="test-language">Recognition language</label>
          <select id="test-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="fa-IR">Persian · فارسی</option>
            <option value="en-US">English · United States</option>
          </select>
        </div>
        {error && (
          <div role="alert" className="notice error mt-4">
            {error}
          </div>
        )}
        <button
          className="button primary w-full mt-5"
          disabled={!file || busy || recording}
          onClick={() => void convert()}
        >
          {busy ? <LoaderCircle size={18} className="animate-spin" /> : <AudioLines size={18} />}{' '}
          {busy ? `Transcribing · ${elapsed}s` : 'Transcode & transcribe'}
        </button>
        <p className="footnote">
          Audio is sent to your selected speech provider. Temporary server files are removed after
          processing.
        </p>
      </section>
      <section className="card result-card">
        <div className="card-heading">
          <span className="icon-box blue">
            <FileAudio size={20} />
          </span>
          <div>
            <h2>Transcription result</h2>
            <p>From a voice note to a clear thought.</p>
          </div>
        </div>
        {file && <Spectrogram file={file} />}
        {result ? (
          <>
            <div className="result-meta">
              <span className="badge green">
                <Check size={12} /> Completed
              </span>
              <span>{(result.durationMs / 1000).toFixed(1)}s processing</span>
              <span>{result.engine}</span>
            </div>
            <div className="transcript" dir="auto">
              {result.text}
            </div>
            <div className="flex gap-3 flex-wrap mt-5">
              <button
                className="button secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(result.text)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    })
                    .catch(() =>
                      setError(
                        'Clipboard access is unavailable. Select and copy the text manually.',
                      ),
                    );
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
                {copied ? 'Copied' : 'Copy text'}
              </button>
              {wavUrl && (
                <a className="button secondary" href={wavUrl} download="transcoded-16khz.wav">
                  <Download size={16} />
                  Download WAV
                </a>
              )}
            </div>
            <p className="footnote">
              16 kHz · 16-bit PCM · mono · {result.audioSeconds.toFixed(1)} seconds
            </p>
          </>
        ) : (
          <div className="empty-result">
            <div className="empty-bars">
              {[16, 28, 46, 65, 40, 76, 52, 31, 46, 20, 12].map((height, i) => (
                <i key={i} style={{ height }} />
              ))}
            </div>
            <h3>{busy ? 'Finding the words…' : 'Good things start with a voice.'}</h3>
            <p>
              {busy
                ? 'Converting your audio and waiting for the speech provider.'
                : 'Upload a file or record a message. Your transcription will appear here.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
