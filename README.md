# Voice Studio Telegram bot

The backend is Python 3.11 with FastAPI. The dashboard is React, TypeScript and Vite. Telegram polling, speech conversion, AI requests, PDF generation, settings, chat history and the dashboard API all run in Python.

## Local setup

Install Python 3.11+, Node 22+, FFmpeg/FFprobe and [WeasyPrint's system libraries](https://doc.courtbouillon.org/weasyprint/stable/first_steps.html#installation). Then:

```sh
cp .env.example .env
# Set ADMIN_PASSWORD to at least 16 characters in .env.
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm ci
npm run dev
```

Open http://127.0.0.1:5173 and sign in. Vite proxies API requests to the Python backend on port 3000. The backend reads `.env` on local startup. For production, `npm run build` builds the frontend and `uvicorn pybackend.app:app --host 127.0.0.1 --port 3000` serves it together with the API. Use one Uvicorn worker so that one process owns Telegram polling and file-backed state. Docker Compose in `deploy/compose.yaml` supplies the environment and runs one worker.

## Bot functions

Save the Telegram token in the dashboard and enable polling. Configure Google ASR, a separate FastAPI transcription endpoint, or Gemini for speech recognition. Google ASR is a legacy unofficial endpoint and may be unavailable. Configure an OpenAI-compatible API or OpenRouter for AI features. Provider keys and the bot token belong in the ignored `.env` or saved dashboard settings, never Git.

- Voice, audio and video notes are transcribed. Audio up to 20 MB and 60 minutes is split into 60-second segments and recombined in order.
- `/summary` summarizes the last 50 received chat messages; `/summary 100` changes the count, up to 100. In groups, disable Telegram privacy mode so the bot receives ordinary messages. The bot cannot retrieve older messages that Telegram never sent it.
- `/language fa-IR` and `/language en-US` set recognition language; only group administrators can change a group's language.
- Reply `/education` to an audio message to transcribe it and generate a Persian study-notes PDF in B Nazanin. The Education prompt is editable in the dashboard.
- Reply `/question Your question` to that PDF to ask about its saved notes. Reply `/image` and attach a JPEG/PNG photo, or send the photo next, to append visible lecture content and update the PDF.
- `/describe on` enables short Persian replies to GIFs and stickers in that conversation; `/describe off` disables them, and `/describe` shows the current state. It starts off in every group and private chat. Only group administrators can change it in groups. Ordinary videos and video notes are ignored. Telegram group privacy mode must be disabled for the bot to receive ordinary GIF and sticker messages. The feature uses the saved custom API key with `cx/gpt-6-luna(low)` (or `gpt-6-luna` at the official OpenAI endpoint); `VISUAL_MODEL` can override the model ID if your compatible router uses another name. Animated TGS stickers use Telegram's still thumbnail when available.

The model must support image input for `/image`. Education source notes are stored privately for 30 days under `DATA_DIR/education-notes`. The bot processes messages in order within each chat while different chats can run concurrently.

## Data and security

`DATA_DIR` defaults to `./data`. The existing `bot_config.json`, `chat_history.json` and gzip Education notes are read by the Python backend without migration. Settings and notes use private filesystem permissions. Secret fields are masked in dashboard responses. An eight-hour HttpOnly session protects the API; cross-origin writes and excessive requests are rejected. Set `APP_ORIGIN`, `COOKIE_SECURE=true` and `TRUST_PROXY=1` behind HTTPS. Keep port 3000 private. Only one process should poll a bot token.

The API routes are `/healthz`, `/api/auth/login`, `/api/auth/session`, `/api/auth/logout`, `/api/bot/config`, `/api/bot/restart`, `/api/bot/audience`, `/api/bot/audience/{id}`, `/api/bot/verify-chatgpt`, `/api/bot/test-summary`, `/api/transcode` and `/api/events`. The dashboard uses the same request and response formats as the previous backend.

The dashboard counts Education PDFs successfully sent or updated from this release onward. It shows a total, group and private-chat subtotals, and each conversation's PDF count and latest PDF time in Audience & groups. Older PDFs cannot be counted reliably because previous releases did not store a lifetime PDF counter.

## Deploy and verify

`.github/workflows/deploy.yml` builds and tests the frontend and Python backend, uploads the built frontend and Python source to `root@109.248.160.162`, and switches the single Compose service after health checks. It runs on pushes to `main`, manually, and every 15 minutes for retries. The workflow needs GitHub Actions secret `DEPLOY_SSH_KEY` for a dedicated server key and optional variable `DEPLOY_PORT`. The server builds a small Python overlay image from its existing runtime image. The standalone Dockerfile remains available for a clean install. The server keeps `.env` and data at `/opt/telegrambot/shared/`. `deploy/server-deploy.sh` restores the prior image if the new one fails health checks and, after a successful deployment, keeps only the active release, one rollback and the overlay base image.

Run `npm run build` and `python -m pytest -q pytests` locally. PDF rendering needs WeasyPrint's native libraries, which are installed in the Linux CI runner and Docker image. Browser checks use `npm run test:browser` with Playwright. Live provider quality and quota require their credentials and working services.
