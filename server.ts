import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import lockfile from 'proper-lockfile';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { Store } from './backend/store.js';
import { AppError } from './backend/http.js';
import { AudioService, MAX_BYTES } from './backend/audio.js';
import { TelegramBot } from './backend/telegram.js';
import { createAuth } from './backend/auth.js';
import { summarize, verifyOpenAI } from './backend/providers.js';
import { mergeConfig, publicConfig } from './shared/config.js';

export function createApp(store: Store, bot: TelegramBot, audio: AudioService, password: string) {
  const app = express();
  const production = process.env.NODE_ENV === 'production';
  const auth = createAuth(password);
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'data:', 'blob:'],
          'media-src': ["'self'", 'blob:', 'data:'],
          'connect-src': ["'self'"],
          'upgrade-insecure-requests': production ? [] : null,
        },
      },
    }),
  );
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
      if (
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== expected)
      ) {
        res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '96kb' }));
  const loginLimiter = rateLimit({
    windowMs: 15 * 60000,
    limit: 15,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });
  const apiLimiter = rateLimit({
    windowMs: 60000,
    limit: 180,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Try again shortly.' },
  });
  const expensiveLimiter = rateLimit({
    windowMs: 60000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Please wait before starting another provider request.' },
  });
  app.post('/api/auth/login', loginLimiter, (req, res) => {
    const body = z.object({ password: z.string().max(512) }).parse(req.body);
    if (!auth.verify(body.password)) {
      res.status(401).json({ error: 'Incorrect dashboard password.' });
      return;
    }
    res
      .cookie('studio_session', auth.issue(), {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 8 * 3600000,
        path: '/',
      })
      .json({ ok: true });
  });
  app.use('/api', auth.guard, apiLimiter);
  app.get('/api/auth/session', (_req, res) => res.json({ ok: true }));
  app.post('/api/auth/logout', (req, res) => {
    auth.revoke(auth.parse(req.headers.cookie));
    res.clearCookie('studio_session', { path: '/' }).json({ ok: true });
  });
  const snapshot = () => ({
    config: publicConfig(store.config),
    status: bot.status,
    readiness: {
      cloud: !!store.config.openRouterApiKey,
      openai: !!store.config.chatGptApiKey,
      asr:
        store.config.transcribeMode === 'fastapi' ||
        !!(store.config.transcribeMode === 'gemini'
          ? store.config.geminiApiKey
          : store.config.googleSpeechApiKey),
    },
  });
  app.get('/api/bot/config', (_req, res) => res.json(snapshot()));
  let updating = false;
  app.post('/api/bot/config', async (req, res) => {
    if (updating) throw new AppError('Another settings update is in progress.', 409);
    updating = true;
    try {
      const previous = store.config;
      const config = mergeConfig(previous, req.body);
      if (config.enabled && !config.token)
        throw new AppError('Add a bot token before enabling polling.', 400);
      await store.saveConfig(config);
      if (previous.token !== config.token || previous.enabled !== config.enabled)
        await bot.reconcile();
      store.log('info', 'Bot settings saved.');
      res.json(snapshot());
    } finally {
      updating = false;
    }
  });
  app.post('/api/bot/restart', expensiveLimiter, async (_req, res) => {
    await bot.reconcile();
    res.json(snapshot());
  });
  app.get('/api/bot/audience', (_req, res) => {
    const chats = Object.values(store.state.chats);
    res.json({
      chats: chats
        .map(({ history: _history, ...chat }) => chat)
        .sort((a, b) => b.lastActive - a.lastActive),
      metrics: {
        ...store.state.metrics,
        groups: chats.filter((c) => c.type !== 'private').length,
        privateUsers: chats.filter((c) => c.type === 'private').length,
        uniqueUsers: Object.keys(store.state.users).length,
        successRate: store.state.metrics.processed
          ? Math.round((store.state.metrics.succeeded / store.state.metrics.processed) * 100)
          : null,
      },
    });
  });
  app.patch('/api/bot/audience/:id', async (req, res) => {
    if (!/^-?\d+$/.test(String(req.params.id))) throw new AppError('Invalid chat ID.', 400);
    const patch = z
      .object({
        enabled: z.boolean().optional(),
        language: z.enum(['fa-IR', 'en-US']).optional(),
        clearHistory: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const chat = store.state.chats[String(req.params.id)];
    if (!chat) throw new AppError('Chat not found.', 404);
    if (patch.enabled !== undefined) chat.enabled = patch.enabled;
    if (patch.language) chat.language = patch.language;
    if (patch.clearHistory) chat.history = [];
    await store.saveState();
    res.json({ ok: true });
  });
  app.post('/api/bot/verify-chatgpt', expensiveLimiter, async (req, res) => {
    const { apiKey, baseUrl } = z
      .object({ apiKey: z.string().max(512).optional(), baseUrl: z.string().optional() })
      .parse(req.body || {});
    const config = mergeConfig(store.config, baseUrl ? { chatGptBaseUrl: baseUrl } : {});
    res.json(await verifyOpenAI(apiKey || config.chatGptApiKey, config.chatGptBaseUrl));
  });
  let summaries = 0;
  app.post('/api/bot/test-summary', expensiveLimiter, async (req, res) => {
    if (summaries >= 2) throw new AppError('Summary workers are busy. Try again shortly.', 429);
    const body = z
      .object({ config: z.unknown().optional() })
      .strict()
      .parse(req.body || {});
    const config = body.config ? mergeConfig(store.config, body.config) : store.config;
    summaries++;
    try {
      res.json(
        await summarize(
          config,
          [
            {
              messageId: 1,
              timestamp: Date.now() - 120000,
              sender: 'سارا',
              text: 'جلسه بررسی پروژه فردا ساعت ده برگزار می‌شود. لطفاً گزارش تست را آماده کنید.',
            },
            {
              messageId: 2,
              timestamp: Date.now() - 60000,
              sender: 'علی',
              text: 'من گزارش تست را تا امشب ارسال می‌کنم. مشکل ورود کاربران هم رفع شد.',
            },
            {
              messageId: 3,
              timestamp: Date.now(),
              sender: 'مریم',
              text: 'طراحی جدید را در فایل dashboard.pdf فرستادم. فردا درباره آن تصمیم می‌گیریم.',
            },
          ],
          (message) => store.log('warn', message),
        ),
      );
    } finally {
      summaries--;
    }
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 2, parts: 3 },
  });
  let uploads = 0;
  const uploadGate: express.RequestHandler = (_req, res, next) => {
    if (uploads >= 2) {
      res.status(429).json({ error: 'Audio upload workers are busy. Try again shortly.' });
      return;
    }
    uploads++;
    res.once('close', () => {
      uploads--;
    });
    next();
  };
  app.post(
    '/api/transcode',
    expensiveLimiter,
    uploadGate,
    upload.single('audio'),
    async (req, res) => {
      if (!req.file) throw new AppError('Upload an audio file using the audio field.', 400);
      const language =
        z.enum(['fa-IR', 'en-US']).optional().parse(req.body?.language) || store.config.language;
      store.state.metrics.processed++;
      try {
        const result = await audio.process(req.file.buffer, store.config, language, true);
        store.state.metrics.succeeded++;
        res.json(result);
      } catch (error) {
        store.state.metrics.failed++;
        throw error;
      } finally {
        await store.saveState();
      }
    },
  );
  app.get('/api/events', (req, res) => {
    if (store.events.listenerCount('log') >= 30)
      throw new AppError('Too many live console connections.', 429);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) res.end();
    };
    send('snapshot', store.logs);
    const onLog = (log: unknown) => send('log', log);
    const onShutdown = () => res.end();
    store.events.on('log', onLog);
    store.events.on('shutdown', onShutdown);
    const heartbeat = setInterval(() => {
      if (!auth.valid(auth.parse(req.headers.cookie))) {
        res.end();
        return;
      }
      res.write(': heartbeat\n\n');
    }, 20000);
    res.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('log', onLog);
      store.events.off('shutdown', onShutdown);
    });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use(express.static(publicDir));
  app.get('/{*splat}', (_req, res, next) =>
    res.sendFile(path.join(publicDir, 'index.html'), (error) => {
      if (error) next(error);
    }),
  );
  const errors: express.ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    if (error instanceof multer.MulterError) {
      res.status(413).json({ error: 'Upload one audio file, at most 20 MB.' });
      return;
    }
    if (error instanceof AppError) {
      res
        .status(error.status >= 400 && error.status < 600 ? error.status : 500)
        .json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON request.' });
      return;
    }
    store.log('error', 'An unexpected request error occurred.');
    res
      .status(500)
      .json({ error: 'Request failed. Check server connectivity and provider configuration.' });
  };
  app.use(errors);
  return app;
}

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 16)
    throw new Error('Set ADMIN_PASSWORD in .env to at least 16 characters before starting.');
  const store = new Store(path.resolve(process.env.DATA_DIR || './data'));
  await mkdir(store.dir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(store.dir, {
    realpath: true,
    lockfilePath: path.join(store.dir, '.instance.lock'),
    stale: 30000,
    update: 10000,
    retries: 0,
  });
  await store.init();
  const audio = new AudioService((message) => store.log('info', message));
  const bot = new TelegramBot(store, audio);
  const app = createApp(store, bot, audio, password);
  const server = app.listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || '127.0.0.1',
    () => {
      store.log('info', `Voice Studio listening on port ${process.env.PORT || 3000}.`);
    },
  );
  server.requestTimeout = 300000;
  const timer = setInterval(() => {
    void store
      .saveState()
      .catch(() =>
        store.log('error', 'Failed to persist chat history. Check disk space and permissions.'),
      );
  }, 15000);
  await bot.reconcile();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    store.log('info', 'Shutting down; waiting for in-flight work.');
    const deadline = setTimeout(() => process.exit(1), 240000);
    deadline.unref();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    store.events.emit('shutdown');
    await bot.stop();
    await closed;
    await store.saveState();
    await release();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exit(1);
  });
