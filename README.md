# Voice Studio — TelegramBot

A TypeScript Telegram voice-to-text and conversation summary bot with an Express API and React, Vite, Tailwind management dashboard.

## Run locally

Use **Node.js 22+**, **FFmpeg and FFprobe**. On Debian/Ubuntu, `sudo apt-get install ffmpeg` installs both audio tools; install Node 22 separately if the distribution ships an older version. On macOS, use `brew install ffmpeg node@22`.

```sh
cp .env.example .env
# Set ADMIN_PASSWORD in .env to a unique password of at least 16 characters.
npm install
npm run dev
```

Open **http://localhost:5173** and sign in with `ADMIN_PASSWORD`. Vite proxies the API and events to Express on port 3000. The backend refuses to start without an admin password.

```sh
npm run build
npm start
```

Production serves the dashboard and API together at **http://127.0.0.1:3000**. Keep it on loopback or behind an HTTPS reverse proxy. Microphone recording needs HTTPS or localhost.

## Connect the bot

1. Create a bot using [BotFather](https://t.me/BotFather). Enter its token under **Telegram bot**, enable polling, and save.
2. Choose a speech engine and configure credentials or the endpoint. Save before testing in **Audio playground**.
3. Configure an OpenRouter key for Server Cloud, or select OpenAI and enter an API key. **Verify & connect** checks credentials; **Save changes** persists them. Test summary uses the current form, including unsaved prompt/provider edits.
4. Send a voice, audio, or video note. Use `/summary` for the last 30 messages, `/summary 50` for a custom count (maximum 100), and `/language fa-IR` or `/language en-US`. Group language commands require a group administrator.
5. For full group history, disable privacy mode with BotFather `/setprivacy` and re-add the bot if necessary. The bot can only summarize messages Telegram has delivered since it started receiving updates. Explain to participants which AI providers process their messages.

Only one process may poll a token. A data-directory lock prevents accidental local duplicates. Telegram 409 conflicts stop the worker and appear in the dashboard; stop the other instance or remove its webhook before clicking **Restart poller**. The app does not delete existing webhooks automatically.

## Provider configuration

| Provider                  | Configuration                           | Behavior                                                                                                                                                                                      |
| ------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FastAPI / Whisper         | `targetApiUrl` or initial `FASTAPI_URL` | POST multipart `file` (16 kHz mono WAV) and `language` (`fa-IR` / `en-US`). Expects `{ "text": "..." }` or `{ "transcription": "..." }`. Deploy the Whisper service separately.               |
| Gemini                    | API key and accessible model            | Sends inline WAV to `generateContent`. Default model is configurable (`gemini-2.5-flash`).                                                                                                    |
| Google Chromium ASR       | Optional compatible Google Speech API key | Matches the supplied `google_asr.py`: Chromium client, public SpeechRecognition compatibility key by default, optional key override, FLAC at 16 kHz, and bounded retries. The legacy endpoint is experimental; availability is not guaranteed. |
| Server Cloud / OpenRouter | OpenRouter API key                      | Defaults to `openrouter/free`. A selected model, including `qwen/qwen3.8-27b:free` if available, falls back to `openrouter/free`.                                                             |
| OpenAI                    | API key and accessible model            | Offers `gpt-4o-mini`, `gpt-4o`, `chatgpt-4o-latest`, plus verified models. Model retirement/access may cause a selected model to fail. Falls back to OpenRouter if its key is configured.     |

**There is no embedded free API key.** Free routes still need credentials and quota. OpenAI API billing is separate from a ChatGPT subscription. Verifying `/v1/models` proves credential access, not inference billing or availability for every listed model. No provider guarantees uninterrupted service; failures produce clear messages rather than fabricated summaries.

Audio is limited to **20 MB and 60 minutes**, with at most two active conversions. WAV output is 16 kHz, 16-bit PCM, mono. The browser includes a real spectrogram, microphone waveform, text copy, and WAV download. Temporary server files are removed after processing. Dashboard transcripts are returned to the browser and are not saved in chat history.

## Custom summary API

Select **OpenAI / custom API**, set the API base URL (including `/v1`), enter the exact model identifier, and save its API key. Verification and completion requests both use that endpoint. The dashboard also lets you edit and save the Education system prompt used by `/education`, or reset it to its original wording. Environment bootstrap supports `LLM_BRAIN=chatgpt`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY`. Keys and the bot token belong in the ignored `.env` or server settings, never Git.

## Persistence and security

- `DATA_DIR` defaults to `./data`. `bot_config.json` stores settings and secrets with mode `0600`; the directory is `0700`. Secrets are **not encrypted at rest**. Protect the host and backups.
- Environment credentials seed the first run. After saving, `bot_config.json` is authoritative. Blank secret inputs preserve stored values; use **Remove saved key** and save to remove a credential.
- `chat_history.json` stores preferences, analytics, update offsets, and 200 messages per chat. Message content expires after 30 days. Tracking is bounded to 5,000 chats and 50,000 recent participant IDs. Directory/message totals are lifetime counters for retained chats.
- History flushes every 15 seconds and after Telegram updates. Updates are acknowledged after handling. A crash before the offset is saved can repeat a reply or provider request; delivery is not exactly-once.
- Admin APIs and SSE require eight-hour HttpOnly, SameSite sessions, bounded to 100, revoked on logout and reset on restart. Cross-origin writes are rejected. Login, API and provider requests are rate-limited.
- Behind one HTTPS reverse proxy, set `COOKIE_SECURE=true`, `TRUST_PROXY=1`, and `APP_ORIGIN=https://your-domain`. Do not expose port 3000 publicly. SSE logs omit credentials and transcript text.
- Downloads, provider calls and FFmpeg execution are bounded. Audio demuxers and file protocols are restricted. FastAPI URLs are administrator-controlled; only trusted admins should access the dashboard.
- This is a single-instance application with file storage. For multiple workers/large audiences, move state/jobs to a database/queue and retain a single Telegram update consumer.

## API

Log in with `POST /api/auth/login` and `{ "password": "..." }`; reuse the session cookie. Errors use `{ "error": "..." }` and meaningful HTTP status codes.

| Method     | Route                     | Purpose                                                                                                                       |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| GET        | `/healthz`                | Public process health, without settings/secrets.                                                                              |
| GET        | `/api/auth/session`       | Check login.                                                                                                                  |
| POST       | `/api/auth/logout`        | Revoke session.                                                                                                               |
| GET / POST | `/api/bot/config`         | Read masked settings/status or save a validated partial configuration. `clearSecrets` explicitly removes credentials.         |
| POST       | `/api/bot/restart`        | Restart an enabled worker after resolving a conflict.                                                                         |
| GET        | `/api/bot/audience`       | Directory, preferences, member counts and analytics. Member counts are best-effort and updated at most hourly.                |
| PATCH      | `/api/bot/audience/:id`   | Set `enabled`, `language`, or `clearHistory: true`. Paused chats are counted but not transcribed or buffered.                 |
| POST       | `/api/bot/verify-chatgpt` | Optional `apiKey`, otherwise saved key. Returns models and latency without credentials.                                       |
| POST       | `/api/bot/test-summary`   | Optional `config` override. Summarizes sample Persian messages and returns text, provider, model, fallback flag and duration. |
| POST       | `/api/transcode`          | Multipart `audio`, optional `language`. Returns transcript, timing, engine, duration and WAV base64.                          |
| GET        | `/api/events`             | SSE `snapshot` / `log` events, 200 events retained in memory.                                                                 |

## Deployment to 109.248.160.162

GitHub is connected to `alimahvashm/TelegramBot`. The deployment workflow publishes the latest `main` on pushes and a 15-minute retry schedule **after deployment is enabled**. GitHub schedules can be delayed; public-repository schedules may be disabled after 60 days without activity. The workflow builds and tests before deploying.

One-time server setup:

1. Install Docker Engine and Docker Compose using the official Docker instructions. Allow SSH from GitHub runners. Configure an HTTPS reverse proxy; `deploy/Caddyfile.example` provides a Caddy configuration.
2. Create `/opt/telegrambot/shared/.env` with a strong `ADMIN_PASSWORD`, `APP_ORIGIN`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, and optional bootstrap provider credentials. Restrict it with `chmod 600`. State is stored in `/opt/telegrambot/shared/data`.
3. Install a dedicated deployment public key in `/root/.ssh/authorized_keys`. Do not upload your personal SSH key to GitHub. Verify the server host-key fingerprint through a trusted console before saving its known-hosts entry.
4. In GitHub **Settings → Secrets and variables → Actions**, configure:

| Type     | Name                 | Value                                                               |
| -------- | -------------------- | ------------------------------------------------------------------- |
| Secret   | `DEPLOY_SSH_KEY`     | Dedicated deployment private key.                                   |
| Secret   | `DEPLOY_KNOWN_HOSTS` | Verified SSH host-key entry (`[host]:port` for a non-default port). |
| Variable | `DEPLOY_PORT`        | Defaults to `22`.                                                   |
| Variable | `DEPLOY_ENABLED`     | `true` after server setup and secrets are complete.                 |

Files are uploaded to `/opt/telegrambot/releases/<commit>`. `deploy/server-deploy.sh` builds the image before stopping the old bot, starts one container, waits for health, and then switches `/opt/telegrambot/current`. It restores the previous image if the new container fails its health check. Releases, images and state are retained; schedule backups and removal of old unused releases/images. Image rollback does not roll back data: take a backup before future schema migrations.

The container runs as UID 1000, exposes port 3000 on server loopback only, and uses a read-only root filesystem, writable data mount, temporary filesystem and resource limits. Inside Docker, `127.0.0.1` refers to the container: configure a reachable private address for an external Whisper service.

Deployment **remains disabled until SSH access and GitHub secrets are configured**. SSH access to the new server is verified. Provider credentials are configured locally, but server credential installation and GitHub deployment secrets still need to be completed; no live-server application deployment has been verified.

## Validation

```sh
npm run build
npm test
# Requires Google Chrome and FFmpeg; uses isolated state and a local mock ASR provider.
npm run test:browser
```

Tests cover secrets, sessions, API access, cross-origin protection, persistence, history caps, summary fallback, Telegram conflicts, actual FFmpeg conversion and input rejection. Audio tests explicitly skip when FFmpeg is missing. Browser checks cover login, settings persistence, microphone recording, transcription through a local test provider, responsive layouts, and logout. External provider quality, billing, and real Telegram delivery require credentials and a live smoke test.

Reference contracts: [Telegram Bot API](https://core.telegram.org/bots/api), [OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list), [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat), [OpenRouter authentication](https://openrouter.ai/docs/api_reference/authentication), [Gemini audio](https://ai.google.dev/gemini-api/docs/audio), [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

### Lecture notes

Reply to a voice message, audio file, or video note with `/education` (or `/education@YourBot`). The bot transcribes that specific recording and uses the configured summary model to create readable Persian study notes, correcting spelling and organization while preserving the lecture’s content and marking unclear passages. It sends the completed notes as an A4 PDF with embedded B Nazanin text, bold B Nazanin headings, right-to-left layout, and page numbers. This command also works when automatic transcript replies are disabled. Current audio limits remain 60 minutes / 20 MB, with a 30-second per-chat request cooldown.

To ask about those notes, reply to the PDF sent by the bot with `/question Your question` (or `/question@YourBot Your question`). The answer uses the configured AI model and only the saved notes behind that PDF. Notes are stored privately on the server for 30 days; PDFs generated before this feature need to be regenerated with `/education` before questions can be answered.

To add content that was shown in a picture but not spoken, reply to an Education PDF with a photo whose caption is `/image`. You can also reply `/image` to the PDF and send a JPEG or PNG photo within 10 minutes. The configured vision-capable AI model reads visible educational content, appends it to the notes, and replaces the PDF in Telegram. If Telegram cannot edit the original message, the bot sends a new updated PDF. The original image must be smaller than 5 MB.

The production image includes WeasyPrint and the B Nazanin regular and bold fonts used for PDF rendering. Install WeasyPrint locally if you run the bot outside Docker.

Long recordings are decoded and transcribed sequentially in 60-second segments. Unrecognized segments are explicitly marked; provider failures abort the job rather than returning incomplete notes. Long education transcripts are processed in ordered sections and assembled without a lossy final summary. WAV download is available only for recordings up to 60 seconds. Telegram cloud downloads still require files no larger than 20 MB.
