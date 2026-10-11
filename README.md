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

- `/report` lets a verified group administrator request a Persian management report in that group from its latest 200 saved messages. It counts the most active members and replies received, then uses GPT-6 Luna with low reasoning (`cx/gpt-6-luna(low)` on the custom router) to flag possible scams, insults, advertising, spam and conflicts. It uses the custom/OpenAI API key with no fallback to other models. Findings include source excerpts, sender IDs where attribution is available, and message links in supergroups. These are review suggestions, not automatic sanctions or confirmed accusations. Model input is capped at 1,500 characters per message. Reports have a 60-second per-group cooldown; if AI fails, activity counts still work. Anonymous admins must send the command from their personal account. Only messages already received by the bot are available; the report is visible to the group.

Sending a public Instagram reel or video-post link automatically replies with the downloaded MP4, without re-encoding. Links in text, captions and linked text are supported (up to three per message; the first video of each post). Private/login-required or unavailable posts may fail, and Instagram can block server downloads. Videos must fit within 49 MB. Downloads have a 90-second deadline, run one at a time, and temporary files are deleted after sending or failure. Group privacy mode must allow the bot to receive links.

Save the Telegram token in the dashboard and enable polling. Configure Google ASR, a separate FastAPI transcription endpoint, or Gemini for speech recognition. Google ASR is a legacy unofficial endpoint and may be unavailable. Configure an OpenAI-compatible API or OpenRouter for AI features. Provider keys and the bot token belong in the ignored `.env` or saved dashboard settings, never Git.

- Voice, audio and video notes are transcribed. Audio up to 20 MB and 60 minutes is split into 60-second segments and recombined in order. When "Clean up transcripts" is enabled and the custom/OpenAI API key is configured, GPT-6 Sol with low reasoning corrects spelling and unusual ASR words in context, then organizes sentences and paragraphs before the transcript is sent or used for `/education`. The model output is returned without comparing it to the original ASR text. Raw ASR text is used only if the model fails or returns an empty, invalid, or truncated response. Set `TRANSCRIPT_POLISH_MODEL` only if your compatible router uses a different model ID.
- `/summary` summarizes the last 50 received chat messages; `/summary 100` changes the count, up to 100. In groups, disable Telegram privacy mode so the bot receives ordinary messages. The bot cannot retrieve older messages that Telegram never sent it.
- `/gpt Your question` answers in the question's language using the previous 20 saved messages from the current chat. Reply with `/gpt Your question` to make the replied-to message explicit context, even if it is older than those 20 messages. Reply with `/gpt` alone to ask for an explanation of that message. When older context is needed, the model can request earlier batches or search older saved messages, up to the 2,000 messages retained per chat. Questions and answers are saved for follow-up questions. This command uses the configured OpenAI/custom API key. It defaults to `gpt-4.1-nano` with the official OpenAI API (the second lowest general text input-price tier in October 2026 pricing), or `cx/gpt-5.6-luna` with the custom router (the second lowest priced available GPT model by OpenAI standard rates). Set `GPT_MODEL` to override either default. Group privacy mode must allow the bot to receive ordinary messages for group context.
- The bot retains up to 2,000 received messages per chat for history. `/profile @username` reads up to 2,000 recent messages from that group, including other members' messages as context; only the target's own attributable messages can support claims about them. Replying to a member with `/profile` also works. The bot can only use group messages it has received, so group privacy mode must allow ordinary messages through. Long message texts are shortened to keep the model request bounded. Cards use GPT-6 Sol with medium reasoning and may leave unsupported traits blank. Edit the Profile system prompt in dashboard settings and save; Reset to default restores its original instructions.
- `/stats` reports stickers successfully described in Persian, successfully delivered user profile cards, voice/audio/video-note messages, known groups, known private chats, and generated PDFs. The sticker description and profile counters start at zero with this release because earlier successful results cannot be distinguished from the old received-sticker total or reconstructed from prior messages.
- `/language fa-IR` and `/language en-US` set recognition language; only group administrators can change a group's language.
- Reply `/education` to an audio message to transcribe it and generate a Persian study-notes PDF in B Nazanin. You can send a photo with `/education` as its caption while replying to the audio, or send a photo album with that caption. Up to 10 photos are read for relevant lecture content and included at the end of the PDF. The Education prompt is editable in the dashboard.
- Reply `/question Your question` to that PDF to ask about its saved notes. Reply `/image` and attach a JPEG/PNG photo, or send the photo next, to append visible lecture content and update the PDF.
- `/describe on` enables short Persian replies to GIFs and stickers in that conversation; `/describe off` disables them, and `/describe` shows the current state. It starts off in every group and private chat. Only group administrators can change it in groups. Ordinary videos and video notes are ignored. Telegram group privacy mode must be disabled for the bot to receive ordinary GIF and sticker messages. The feature uses the saved custom API key with `cx/gpt-6-luna(low)` (or `gpt-6-luna` at the official OpenAI endpoint); `VISUAL_MODEL` can override the model ID if your compatible router uses another name. Animated TGS stickers use Telegram's still thumbnail when available.

The model must support image input for `/image` and photo attachments to `/education`. Education source notes and small copies of attached photos are stored privately for 30 days under `DATA_DIR/education-notes` and `DATA_DIR/education-images`. The bot processes messages in order within each chat while different chats can run concurrently.

## Data and security

`DATA_DIR` defaults to `./data`. The existing `bot_config.json`, `chat_history.json` and gzip Education notes are read by the Python backend without migration. Settings and notes use private filesystem permissions. Secret fields are masked in dashboard responses. An eight-hour HttpOnly session protects the API; cross-origin writes and excessive requests are rejected. Set `APP_ORIGIN`, `COOKIE_SECURE=true` and `TRUST_PROXY=1` behind HTTPS. Keep port 3000 private. Only one process should poll a bot token.

The API routes are `/healthz`, `/api/auth/login`, `/api/auth/session`, `/api/auth/logout`, `/api/bot/config`, `/api/bot/restart`, `/api/bot/audience`, `/api/bot/audience/{id}`, `/api/bot/verify-chatgpt`, `/api/bot/test-summary`, `/api/transcode` and `/api/events`. The dashboard uses the same request and response formats as the previous backend.

The dashboard counts Education PDFs successfully sent or updated from this release onward. It shows a total, group and private-chat subtotals, and each conversation's PDF count and latest PDF time in Audience & groups. Older PDFs cannot be counted reliably because previous releases did not store a lifetime PDF counter.

## Deploy and verify

`.github/workflows/deploy.yml` builds and tests the frontend and Python backend, uploads the built frontend and Python source to `root@109.248.160.162`, and switches the single Compose service after health checks. It runs on pushes to `main`, manually, and every 15 minutes for retries. The workflow needs GitHub Actions secret `DEPLOY_SSH_KEY` for a dedicated server key and optional variable `DEPLOY_PORT`. The server builds a small Python overlay image from its existing runtime image. The standalone Dockerfile remains available for a clean install. The server keeps `.env` and data at `/opt/telegrambot/shared/`. `deploy/server-deploy.sh` restores the prior image if the new one fails health checks and, after a successful deployment, keeps only the active release, one rollback and the overlay base image.

Run `npm run build` and `python -m pytest -q pytests` locally. PDF rendering needs WeasyPrint's native libraries, which are installed in the Linux CI runner and Docker image. Browser checks use `npm run test:browser` with Playwright. Live provider quality and quota require their credentials and working services.
