import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: 'chrome',
    viewport: { width: 1440, height: 1100 },
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `${process.env.PYTHON || 'python3'} -m uvicorn pybackend.app:app --host 127.0.0.1 --port 4174`,
    url: 'http://127.0.0.1:4174/healthz',
    reuseExistingServer: false,
    env: {
      PORT: '4174',
      APP_ORIGIN: 'http://127.0.0.1:4174',
      COOKIE_SECURE: 'false',
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: 'browser-test-password-only',
      DATA_DIR: mkdtempSync(path.join(tmpdir(), 'voice-studio-browser-')),
      BOT_ENABLED: 'false',
      TELEGRAM_BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_SPEECH_API_KEY: '',
    },
  },
});
