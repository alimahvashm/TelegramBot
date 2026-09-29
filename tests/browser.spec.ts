import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';

let whisper: Server;
let whisperUrl: string;
test.beforeAll(async () => {
  whisper = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Consume multipart upload. */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'This is a local test transcription.' }));
  });
  await new Promise<void>((resolve) => whisper.listen(0, '127.0.0.1', resolve));
  const address = whisper.address();
  if (!address || typeof address === 'string') throw new Error('No test provider port');
  whisperUrl = `http://127.0.0.1:${address.port}/voice`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => whisper.close(() => resolve()));
});
test('dashboard settings, empty audience, recording, transcription, responsive layout and logout', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Dashboard password').fill('browser-test-password-only');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Telegram bot.' })).toBeVisible();
  await expect(page.getByText('Server connected')).toBeVisible();
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.getByLabel('Speech recognition engine').selectOption('fastapi');
  await page.getByLabel('Whisper endpoint').fill(whisperUrl);
  await page.getByLabel('Welcome message').fill('Hello from the integration test.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.reload();
  await expect(page.getByLabel('Welcome message')).toHaveValue('Hello from the integration test.');
  await page.getByRole('button', { name: 'Test conversation summary' }).click();
  await expect(page.getByRole('alert')).toContainText('No summary provider is configured');
  await page.getByRole('button', { name: 'Audience & groups', exact: true }).click();
  await expect(page.getByText('Your audience starts with a hello.')).toBeVisible();
  await page.getByRole('button', { name: 'Audio playground', exact: true }).click();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByText('Listening to your microphone')).toBeVisible({ timeout: 25000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('recording.webm')).toBeVisible();
  await page.getByRole('button', { name: 'Transcode & transcribe' }).click();
  await expect(page.getByText('This is a local test transcription.')).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByRole('link', { name: 'Download WAV' })).toHaveAttribute('href', /^blob:/);
  await page.screenshot({ path: 'test-results/audio-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Audio playground.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/audio-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Telegram bot', exact: true }).click();
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Voice Studio.' })).toBeVisible();
  expect(errors).toEqual([]);
});
