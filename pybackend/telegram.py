"""Telegram long polling, per-chat ordering, and bot commands."""
import asyncio
import hashlib
import json
import re
import time
from collections import deque
from datetime import datetime, timezone
import httpx
from .audio import AudioService, MAX_BYTES, MAX_SECONDS
from .config import summary_count
from .errors import AppError, request_json, response_bytes
from .pdf import render_education_pdf
from .providers import summarize, create_education_notes, answer_education_question, describe_education_image
from .store import Store

MAX_IMAGE = 5 * 1024 * 1024

def chunks(text: str, size: int = 3900) -> list[str]:
    return [text[index:index + size] for index in range(0, len(text), size)]

class TelegramBot:
    def __init__(self, store: Store, audio: AudioService, pdf_renderer=render_education_pdf):
        self.store = store
        self.audio = audio
        self.pdf_renderer = pdf_renderer
        self.client = httpx.AsyncClient()
        self.status = {'state': 'stopped', 'error': None, 'bot': None, 'lastPoll': None}
        self.running: asyncio.Task | None = None
        self.stop_event = asyncio.Event()
        self.control_lock = asyncio.Lock()
        self.education_times = {}
        self.summary_times = {}
        self.question_times = {}
        self.pending_images = {}

    async def close(self):
        await self.stop()
        await self.client.aclose()

    async def call(self, token: str, method: str, data: dict | None = None, timeout: float | None = None):
        result = await request_json(self.client, 'POST', f'https://api.telegram.org/bot{token}/{method}',
            timeout=timeout or (40 if method == 'getUpdates' else 20), json=data or {})
        if not result.get('ok'):
            raise AppError('Telegram API request failed.', result.get('error_code', 502))
        return result['result']

    async def reconcile(self):
        async with self.control_lock:
            await self.stop()
            self.status = {'state': 'stopped', 'error': None, 'bot': None, 'lastPoll': None}
            config = self.store.config
            if config['enabled'] and config['token']:
                self.stop_event = asyncio.Event()
                self.running = asyncio.create_task(self.loop(config['token']))

    async def stop(self):
        self.stop_event.set()
        if self.running:
            await self.running
            self.running = None
        self.status['state'] = 'stopped'

    async def loop(self, token: str):
        identity = hashlib.sha256(token.encode()).hexdigest()[:20]
        poll_offset = self.store.state['offsets'].get(identity, 0)
        pending = deque()
        chat_queues: dict[str, asyncio.Task] = {}
        jobs: set[asyncio.Task] = set()
        failures = 0

        async def process(update: dict, previous: asyncio.Task | None, entry: dict):
            if previous:
                await previous
            try:
                if update.get('message'):
                    await self.handle(token, update['message'], self.store.config)
            except Exception:
                self.store.log('error', 'Message processing failed; the update has been recorded.')
            entry['done'] = True
            while pending and pending[0]['done']:
                self.store.state['offsets'][identity] = pending.popleft()['id'] + 1
            try:
                await self.store.save_state()
            except Exception:
                self.store.log('error', 'Could not save processed update state.')

        try:
            while not self.stop_event.is_set():
                try:
                    if not self.status['bot']:
                        self.status['state'] = 'connecting'
                        self.status['bot'] = await self.call(token, 'getMe')
                        webhook = await self.call(token, 'getWebhookInfo')
                        if webhook.get('url'):
                            raise AppError('A webhook is active. Remove it before starting long polling.', 409)
                        me = self.status['bot']
                        self.store.log('info', f'Connected to @{me.get("username") or me["id"]}.')
                    updates = await self.call(token, 'getUpdates', {
                        'offset': poll_offset, 'timeout': 30, 'limit': 20, 'allowed_updates': ['message']}, 40)
                    self.status.update(state='polling', error=None, lastPoll=int(time.time() * 1000))
                    failures = 0
                    for update in updates:
                        if self.stop_event.is_set():
                            break
                        if update['update_id'] < poll_offset:
                            continue
                        entry = {'id': update['update_id'], 'done': False}
                        pending.append(entry)
                        chat_id = str(update.get('message', {}).get('chat', {}).get('id', f'update:{entry["id"]}'))
                        previous = chat_queues.get(chat_id)
                        job = asyncio.create_task(process(update, previous, entry))
                        chat_queues[chat_id] = job
                        jobs.add(job)
                        job.add_done_callback(jobs.discard)
                        poll_offset = update['update_id'] + 1
                    if len(jobs) >= 100:
                        await asyncio.wait(jobs, return_when=asyncio.FIRST_COMPLETED)
                except Exception as exc:
                    if self.stop_event.is_set():
                        break
                    code = exc.status if isinstance(exc, AppError) else 0
                    self.status['state'] = 'conflict' if code == 409 else 'error'
                    self.status['error'] = ('Telegram conflict: another poller or webhook is using this token. Stop the other instance, then restart here.'
                        if code == 409 else 'Telegram rejected the bot token.' if code == 401 else
                        'Telegram is temporarily unavailable. Retrying automatically.')
                    self.store.log('error', self.status['error'])
                    if code in (401, 409):
                        break
                    self.status['bot'] = None
                    try:
                        await asyncio.wait_for(self.stop_event.wait(), min(60, 2 * (2 ** min(failures, 5))))
                    except asyncio.TimeoutError:
                        pass
                    failures += 1
        finally:
            if jobs:
                await asyncio.gather(*jobs, return_exceptions=True)

    async def reply(self, token: str, message: dict, text: str):
        for part in chunks(text):
            await self.call(token, 'sendMessage', {'chat_id': message['chat']['id'], 'text': part,
                'reply_parameters': {'message_id': message['message_id'], 'allow_sending_without_reply': True}})

    async def send_pdf(self, token: str, message: dict, pdf: bytes, caption='📚 جزوهٔ آموزشی') -> int:
        url = f'https://api.telegram.org/bot{token}/sendDocument'
        response = await request_json(self.client, 'POST', url, timeout=120,
            data={'chat_id': str(message['chat']['id']), 'caption': caption,
                  'reply_parameters': json.dumps({'message_id': message['message_id'], 'allow_sending_without_reply': True})},
            files={'document': ('education-notes.pdf', pdf, 'application/pdf')})
        if not response.get('ok'):
            raise AppError('Telegram did not accept the PDF document.', 502)
        return response['result']['message_id']

    async def edit_pdf(self, token: str, chat_id: str, message_id: int, pdf: bytes):
        response = await request_json(self.client, 'POST', f'https://api.telegram.org/bot{token}/editMessageMedia', timeout=120,
            data={'chat_id': chat_id, 'message_id': str(message_id), 'media': json.dumps({
                'type': 'document', 'media': 'attach://document', 'caption': '📚 جزوهٔ آموزشی (به‌روزرسانی‌شده)'})},
            files={'document': ('education-notes.pdf', pdf, 'application/pdf')})
        if not response.get('ok'):
            raise AppError('Telegram did not accept the edited PDF.', 502)

    def chat(self, message: dict, config: dict) -> dict:
        chat_data = message['chat']
        chat_id = str(chat_data['id'])
        chats = self.store.state['chats']
        chat = chats.get(chat_id) or {'id': chat_id, 'title': '', 'type': chat_data['type'],
            'language': config['language'], 'enabled': True, 'memberCount': None, 'membersUpdatedAt': 0,
            'messageCount': 0, 'audioCount': 0, 'pdfCount': 0, 'lastPdfAt': None,
            'lastActive': 0, 'history': []}
        chat['title'] = chat_data.get('title') or chat_data.get('first_name') or f'Chat {chat_id}'
        chat['type'] = chat_data['type']
        chat['lastActive'] = int(time.time() * 1000)
        chat['messageCount'] += 1
        today = datetime.now(timezone.utc).date().isoformat()
        daily = chat.setdefault('dailyMessages', {})
        daily[today] = daily.get(today, 0) + 1
        chats[chat_id] = chat
        if message.get('from'):
            self.store.state['users'][str(message['from']['id'])] = int(time.time() * 1000)
        return chat

    async def handle(self, token: str, message: dict, config: dict):
        if message.get('from', {}).get('is_bot'):
            return
        chat = self.chat(message, config)
        if not chat['enabled']:
            return
        if chat['type'] != 'private' and int(time.time() * 1000) - chat['membersUpdatedAt'] > 3600000:
            chat['membersUpdatedAt'] = int(time.time() * 1000)
            try:
                chat['memberCount'] = await self.call(token, 'getChatMemberCount', {'chat_id': message['chat']['id']})
            except Exception:
                pass
        sender_id = message.get('from', {}).get('id', 0)
        pending_key = f'{chat["id"]}:{sender_id}'
        pending = self.pending_images.get(pending_key)
        if pending and pending['expires'] < time.time():
            self.pending_images.pop(pending_key, None)
        elif pending and self.image_media(message) and not message.get('caption', '').startswith('/'):
            self.pending_images.pop(pending_key, None)
            await self.apply_image(token, message, chat, config, pending['documentId'])
            return
        command_text = message.get('text') or (message.get('caption') if message.get('caption', '').startswith('/image') else None)
        match = re.fullmatch(r'/(\w+)(?:@([\w]+))?(?:\s+(.*))?', command_text or '', re.S)
        if match and (not match.group(2) or match.group(2).lower() == (self.status['bot'] or {}).get('username', '').lower()):
            command, argument = match.group(1), (match.group(3) or '').strip()
            if command == 'start':
                await self.reply(token, message, config['startMessage']); return
            if command == 'language':
                if chat['type'] != 'private':
                    member = await self.call(token, 'getChatMember', {'chat_id': chat['id'], 'user_id': sender_id})
                    if member['status'] not in ('creator', 'administrator'):
                        await self.reply(token, message, 'Only group administrators can change the group language.'); return
                if argument in ('fa-IR', 'en-US'):
                    chat['language'] = argument
                    await self.reply(token, message, f'Recognition language: {argument}')
                else:
                    await self.reply(token, message, 'Use /language fa-IR or /language en-US.')
                return
            if command == 'education':
                await self.education(token, message, chat, config); return
            if command == 'question':
                await self.question(token, message, chat, config, argument); return
            if command == 'image':
                await self.image(token, message, chat, config); return
            if command == 'summary':
                await self.summary(token, message, chat, config, argument); return
        sender = ' '.join(filter(None, [message.get('from', {}).get('first_name'), message.get('from', {}).get('last_name')])) or message.get('sender_chat', {}).get('title') or 'Unknown'
        def remember(text):
            self.store.remember(chat, {'messageId': message['message_id'], 'timestamp': message.get('date', 0) * 1000,
                'sender': sender, 'text': text})
        text = message.get('text') or message.get('caption') or (f'[Shared file: {message["document"].get("file_name", "unnamed")}]' if message.get('document') else '')
        if text:
            remember(text)
        media = message.get('voice') or message.get('audio') or message.get('video_note')
        if not media:
            return
        chat['audioCount'] += 1
        self.store.state['metrics']['processed'] += 1
        self.store.log('info', f'Incoming audio in chat {chat["id"]}.')
        try:
            transcription = await self.transcribe_media(token, media, config, chat['language'])
            remember('\n'.join(filter(None, [text, '[Voice transcript] ' + transcription])))
            self.store.state['metrics']['succeeded'] += 1
        except Exception as exc:
            self.store.state['metrics']['failed'] += 1
            code = f', HTTP {exc.status}' if isinstance(exc, AppError) else ', network or runtime error'
            self.store.log('warn', f'Audio processing failed in chat {chat["id"]} ({config["transcribeMode"]}{code}).')
            if config['autoReply']:
                await self.reply(token, message, str(exc) if isinstance(exc, AppError) and exc.status in (413, 422) else
                                 'Transcription is unavailable. Please try again later or ask the bot administrator to check the speech provider.')
            return
        if config['autoReply']:
            await self.reply(token, message, transcription)
            self.store.log('info', f'Transcript reply delivered to chat {chat["id"]}.')

    async def transcribe_media(self, token: str, media: dict, config: dict, language: str, progress=None):
        if media.get('file_size', 0) > MAX_BYTES or media.get('duration', 0) > MAX_SECONDS:
            raise AppError('Audio must be under 20 MB and 60 minutes.', 413)
        file = await self.call(token, 'getFile', {'file_id': media['file_id']})
        if not file.get('file_path') or file.get('file_size', 0) > MAX_BYTES:
            raise AppError('Telegram file is unavailable or exceeds 20 MB.', 413)
        response = await self.client.get(f'https://api.telegram.org/file/bot{token}/{file["file_path"]}',
                                         timeout=30, follow_redirects=False)
        if response.status_code >= 400:
            raise AppError('Telegram audio download failed.', 502)
        data = await response_bytes(response, MAX_BYTES)
        result = await self.audio.process(data, config, language, False, progress)
        return result['text']

    async def education(self, token: str, message: dict, chat: dict, config: dict):
        source = message.get('reply_to_message') or {}
        media = source.get('voice') or source.get('audio') or source.get('video_note')
        if not media:
            await self.reply(token, message, '📚 برای ساخت جزوه، روی پیام صوتی استاد ریپلای کنید و /education را بفرستید.'); return
        now = time.time()
        if now - self.education_times.get(chat['id'], 0) < 30:
            await self.reply(token, message, 'لطفاً بین درخواست‌های جزوه ۳۰ ثانیه صبر کنید.'); return
        self.education_times[chat['id']] = now
        progress = await self.call(token, 'sendMessage', {'chat_id': chat['id'],
            'text': '⏳ در حال تبدیل صوت به متن و آماده‌سازی جزوه…',
            'reply_parameters': {'message_id': message['message_id'], 'allow_sending_without_reply': True}})
        stage = 'transcription'
        notes_ready = False
        self.store.state['metrics']['processed'] += 1
        async def update(text):
            try:
                await self.call(token, 'editMessageText', {'chat_id': chat['id'], 'message_id': progress['message_id'], 'text': text})
            except Exception:
                pass
        try:
            async def transcription_progress(done, total):
                await update(f'⏳ تبدیل صوت به متن: {done} از {total} بخش تکمیل شد.')
            transcript = await self.transcribe_media(token, media, config, chat['language'], transcription_progress)
            self.store.state['metrics']['succeeded'] += 1
            stage = 'education'
            async def note_progress(done, total):
                await update(f'📝 آماده‌سازی جزوه: بخش {done + 1} از {total}')
            result = await create_education_notes(config, transcript, lambda msg: self.store.log('warn', msg), note_progress)
            output = result['text']
            notes_ready = True
            self.store.log('info', f'Education notes generated using {result["provider"]}.')
        except Exception as exc:
            if stage == 'transcription':
                self.store.state['metrics']['failed'] += 1
            self.store.log('warn', f'Education {stage} failed' + (f' (HTTP {exc.status})' if isinstance(exc, AppError) else '') + '.')
            output = ('تهیهٔ جزوه موقتاً ممکن نیست. لطفاً دسترسی و سهمیهٔ مدل هوش مصنوعی را بررسی کنید و دوباره تلاش کنید.'
                      if stage == 'education' else
                      'فایل صوتی باید حداکثر ۶۰ دقیقه و کمتر از ۲۰ مگابایت باشد.' if isinstance(exc, AppError) and exc.status == 413 else
                      'گفتار واضحی تشخیص داده نشد یا فایل صوتی قابل خواندن نیست.' if isinstance(exc, AppError) and exc.status == 422 else
                      'تبدیل صوت به متن موقتاً ممکن نیست. لطفاً دوباره تلاش کنید.')
        if notes_ready:
            try:
                await update('📄 در حال آماده‌سازی فایل PDF…')
                document_id = await self.send_pdf(token, message, await self.pdf_renderer(output))
                self.store.record_pdf(chat)
                try:
                    await self.store.save_education_notes(chat['id'], document_id, output)
                except Exception:
                    self.store.log('error', f'Could not save Education PDF notes for chat {chat["id"]}.')
                self.store.log('info', f'Education PDF delivered to chat {chat["id"]}.')
                output = '📄 جزوهٔ آموزشی به صورت PDF ارسال شد.'
            except Exception as exc:
                self.store.log('warn', f'Education PDF failed' + (f' (HTTP {exc.status})' if isinstance(exc, AppError) else '') + '.')
                output = 'ساخت یا ارسال PDF ممکن نشد. لطفاً دوباره تلاش کنید یا از مدیر ربات بخواهید سرویس PDF را بررسی کند.'
        await self.call(token, 'editMessageText', {'chat_id': chat['id'], 'message_id': progress['message_id'], 'text': output})

    def is_own_pdf(self, source: dict | None) -> bool:
        return bool(source and source.get('document', {}).get('file_name') == 'education-notes.pdf' and
                    source.get('from', {}).get('id') == (self.status['bot'] or {}).get('id'))

    async def question(self, token: str, message: dict, chat: dict, config: dict, question: str):
        if not question:
            await self.reply(token, message, 'روی فایل PDF جزوه ریپلای کنید و بنویسید: /question سوال شما'); return
        if len(question) > 2000:
            await self.reply(token, message, 'پرسش باید کوتاه‌تر از ۲۰۰۰ نویسه باشد.'); return
        source = message.get('reply_to_message')
        if not self.is_own_pdf(source):
            await self.reply(token, message, 'برای پرسیدن سؤال، روی فایل PDF جزوه‌ای که این ربات ساخته ریپلای کنید.'); return
        notes = await self.store.read_education_notes(chat['id'], source['message_id'])
        if not notes:
            await self.reply(token, message, 'متن این جزوه ذخیره نشده است. لطفاً دوباره با /education آن را بسازید و سپس سؤال بپرسید.'); return
        now = time.time()
        if now - self.question_times.get(chat['id'], 0) < 10:
            await self.reply(token, message, 'لطفاً چند ثانیه صبر کنید و دوباره سؤال بپرسید.'); return
        self.question_times[chat['id']] = now
        progress = await self.call(token, 'sendMessage', {'chat_id': chat['id'],
            'text': '⏳ در حال بررسی جزوه و آماده‌سازی پاسخ…',
            'reply_parameters': {'message_id': message['message_id'], 'allow_sending_without_reply': True}})
        try:
            async def on_progress(done, total):
                try:
                    await self.call(token, 'editMessageText', {'chat_id': chat['id'],
                        'message_id': progress['message_id'], 'text': f'⏳ بررسی جزوه: بخش {done} از {total}'})
                except Exception:
                    pass
            result = await answer_education_question(config, notes, question, lambda msg: self.store.log('warn', msg), on_progress)
            answer = result['text']
        except Exception as exc:
            self.store.log('warn', f'Education question failed' + (f' (HTTP {exc.status})' if isinstance(exc, AppError) else '') + '.')
            answer = 'پاسخ‌دهی به پرسش موقتاً ممکن نیست. لطفاً دسترسی و سهمیهٔ مدل را بررسی کنید و دوباره تلاش کنید.'
        parts = chunks(answer)
        await self.call(token, 'editMessageText', {'chat_id': chat['id'], 'message_id': progress['message_id'], 'text': parts[0]})
        for part in parts[1:]:
            await self.reply(token, message, part)

    @staticmethod
    def image_media(message: dict) -> dict | None:
        if message.get('photo'):
            return message['photo'][-1]
        document = message.get('document') or {}
        if document.get('mime_type', '').startswith('image/') and document.get('file_id'):
            return document
        return None

    async def image(self, token: str, message: dict, chat: dict, config: dict):
        source = message.get('reply_to_message')
        if not self.is_own_pdf(source):
            await self.reply(token, message, 'برای افزودن تصویر، روی فایل PDF جزوه‌ای که این ربات ساخته ریپلای کنید.'); return
        if not await self.store.read_education_notes(chat['id'], source['message_id']):
            await self.reply(token, message, 'متن این جزوه ذخیره نشده است. لطفاً دوباره با /education آن را بسازید و سپس تصویر را اضافه کنید.'); return
        if not self.image_media(message):
            sender_id = message.get('from', {}).get('id')
            if not sender_id:
                await self.reply(token, message, 'تصویر را با کپشن /image در ریپلای به فایل PDF بفرستید.'); return
            self.pending_images[f'{chat["id"]}:{sender_id}'] = {'documentId': source['message_id'], 'expires': time.time() + 600}
            await self.reply(token, message, 'حالا تصویر را بفرستید. محتوای خوانای آن به همین جزوه افزوده می‌شود.'); return
        await self.apply_image(token, message, chat, config, source['message_id'])

    async def apply_image(self, token: str, message: dict, chat: dict, config: dict, document_id: int):
        original = await self.store.read_education_notes(chat['id'], document_id)
        if not original:
            await self.reply(token, message, 'متن این جزوه دیگر در سرور موجود نیست. لطفاً دوباره با /education آن را بسازید.'); return
        media = self.image_media(message)
        if not media:
            return
        if media.get('file_size', 0) > MAX_IMAGE:
            await self.reply(token, message, 'تصویر باید کوچک‌تر از ۵ مگابایت باشد.'); return
        progress = await self.call(token, 'sendMessage', {'chat_id': chat['id'],
            'text': '⏳ در حال خواندن تصویر و به‌روزرسانی جزوه…',
            'reply_parameters': {'message_id': message['message_id'], 'allow_sending_without_reply': True}})
        try:
            file = await self.call(token, 'getFile', {'file_id': media['file_id']})
            if not file.get('file_path') or file.get('file_size', 0) > MAX_IMAGE:
                raise AppError('The image exceeds the size limit.', 413)
            response = await self.client.get(f'https://api.telegram.org/file/bot{token}/{file["file_path"]}', timeout=30,
                                             follow_redirects=False)
            if response.status_code >= 400:
                raise AppError('Telegram image download failed.', 502)
            image = await response_bytes(response, MAX_IMAGE)
            mime = 'image/jpeg' if image.startswith(b'\xff\xd8\xff') else 'image/png' if image.startswith(b'\x89PNG\r\n\x1a\n') else None
            if not mime:
                raise AppError('Send a JPEG or PNG image.', 415)
            result = await describe_education_image(config, image, mime, lambda msg: self.store.log('warn', msg))
            if re.fullmatch(r'NO_CONTENT[.!\s]*', result['text'], re.I):
                raise AppError('No readable educational content was found in the image.', 422)
            updated = original + '\n\n──────────\n\n📷 مطالب تکمیلی از تصویر\n\n' + result['text']
            pdf = await self.pdf_renderer(updated)
            new_id = document_id
            edited = True
            try:
                await self.edit_pdf(token, chat['id'], document_id, pdf)
            except Exception:
                edited = False
                new_id = await self.send_pdf(token, message, pdf, '📚 جزوهٔ آموزشی به‌روزرسانی‌شده')
            self.store.record_pdf(chat)
            await self.store.save_education_notes(chat['id'], document_id, updated)
            if new_id != document_id:
                await self.store.save_education_notes(chat['id'], new_id, updated)
            status = '✅ تصویر خوانده شد و فایل PDF همین جزوه به‌روزرسانی شد.' if edited else '✅ تصویر خوانده شد و نسخهٔ جدید PDF ارسال شد.'
            self.store.log('info', f'Education PDF updated from an image in chat {chat["id"]}.')
        except Exception as exc:
            self.store.log('warn', 'Education image update failed' + (f' (HTTP {exc.status})' if isinstance(exc, AppError) else '') + '.')
            status = str(exc) if isinstance(exc, AppError) and exc.status in (413, 415, 422) else \
                'خواندن تصویر یا به‌روزرسانی PDF ممکن نشد. لطفاً تصویر واضح‌تری بفرستید یا دسترسی مدل را بررسی کنید.'
        await self.call(token, 'editMessageText', {'chat_id': chat['id'], 'message_id': progress['message_id'], 'text': status})

    async def summary(self, token: str, message: dict, chat: dict, config: dict, argument: str):
        try:
            count = summary_count(argument)
        except ValueError as exc:
            await self.reply(token, message, str(exc)); return
        self.store.prune()
        if not chat['history']:
            await self.reply(token, message,
                'No conversation history yet. For groups, check the bot’s privacy mode in BotFather so it can receive messages.'); return
        now = time.time()
        if now - self.summary_times.get(chat['id'], 0) < 30:
            await self.reply(token, message, 'Please wait 30 seconds between summaries.'); return
        self.summary_times[chat['id']] = now
        try:
            await self.call(token, 'sendChatAction', {'chat_id': chat['id'], 'action': 'typing'})
        except Exception:
            pass
        progress = await self.call(token, 'sendMessage', {'chat_id': chat['id'], 'text': '⏳ Analyzing and summarizing recent messages...'})
        try:
            result = await summarize(config, chat['history'][-count:], lambda msg: self.store.log('warn', msg))
            output = result['text']
            self.store.state['metrics']['summaries'] += 1
            self.store.log('info', f'Summary generated using {result["provider"]}' + (' (fallback)' if result['fallback'] else '') + '.')
        except Exception:
            output = 'Summary temporarily unavailable. Please ask the administrator to check AI credentials, model access and quota, then try again.'
        parts = chunks(output)
        await self.call(token, 'editMessageText', {'chat_id': chat['id'], 'message_id': progress['message_id'], 'text': parts[0]})
        for part in parts[1:]:
            await self.call(token, 'sendMessage', {'chat_id': chat['id'], 'text': part})
