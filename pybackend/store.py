"""Atomic JSON state and private PDF source notes, compatible with the Node release."""
import asyncio
import gzip
import json
import os
import re
import time
from collections import deque
from pathlib import Path
from uuid import uuid4
from .config import from_environment, validate_config, SECRETS

DAY_MS = 86400000

class Store:
    def __init__(self, directory: str | Path):
        self.dir = Path(directory)
        self.config = from_environment()
        self.state = {'chats': {}, 'users': {}, 'offsets': {},
                      'metrics': {'processed': 0, 'succeeded': 0, 'failed': 0, 'summaries': 0}}
        self.logs: deque[dict] = deque(maxlen=200)
        self.subscribers: set[asyncio.Queue] = set()
        self._write_lock = asyncio.Lock()
        self._log_id = 0

    async def init(self):
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.dir, 0o700)
        config_file = self.dir / 'bot_config.json'
        if config_file.exists():
            self.config = validate_config(json.loads(config_file.read_text()))
        state_file = self.dir / 'chat_history.json'
        if state_file.exists():
            self.state = json.loads(state_file.read_text())
        if any(key not in self.state for key in ('chats', 'users', 'offsets', 'metrics')):
            raise RuntimeError('Invalid chat_history.json. Restore from a backup.')
        metrics = self.state['metrics']
        metrics.setdefault('pdfTrackingStartedAt', int(time.time() * 1000))
        for key in ('pdfsGenerated', 'groupPdfs', 'privatePdfs'):
            metrics.setdefault(key, 0)
        for chat in self.state['chats'].values():
            chat.setdefault('pdfCount', 0)
            chat.setdefault('lastPdfAt', None)
            chat.setdefault('describeMedia', False)
        self.prune()
        await self.prune_education_notes()
        await self.prune_education_images()

    def record_pdf(self, chat: dict):
        now = int(time.time() * 1000)
        chat['pdfCount'] = chat.get('pdfCount', 0) + 1
        chat['lastPdfAt'] = now
        metrics = self.state['metrics']
        metrics['pdfsGenerated'] += 1
        metrics['privatePdfs' if chat['type'] == 'private' else 'groupPdfs'] += 1

    async def _write(self, name: str, value):
        async with self._write_lock:
            target = self.dir / name
            temp = target.with_name(target.name + '.' + uuid4().hex + '.tmp')
            try:
                temp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
                os.chmod(temp, 0o600)
                os.replace(temp, target)
            finally:
                temp.unlink(missing_ok=True)

    async def save_config(self, config: dict):
        await self._write('bot_config.json', config)
        self.config = config

    async def save_state(self):
        self.prune()
        await self._write('chat_history.json', self.state)

    def prune(self):
        cutoff = time.time() * 1000 - 30 * DAY_MS
        for chat in self.state['chats'].values():
            chat['history'] = [entry for entry in chat.get('history', [])
                               if entry.get('timestamp', 0) >= cutoff][-200:]
            if 'dailyMessages' in chat:
                chat['dailyMessages'] = {day: count for day, count in chat['dailyMessages'].items()
                                         if self._day_ms(day) >= cutoff}
        chats = sorted(self.state['chats'].items(), key=lambda item: item[1].get('lastActive', 0), reverse=True)
        self.state['chats'] = dict(chats[:5000])
        users = sorted(((key, value) for key, value in self.state['users'].items() if value >= cutoff),
                       key=lambda item: item[1], reverse=True)
        self.state['users'] = dict(users[:50000])

    @staticmethod
    def _day_ms(day: str) -> int:
        try:
            from datetime import datetime, timezone
            return int(datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            return 0

    def remember(self, chat: dict, message: dict):
        if not message['text'].strip():
            return
        history = chat['history']
        history[:] = [item for item in history if item['messageId'] != message['messageId']]
        history.append(message)
        chat['history'] = history[-200:]

    def log(self, level: str, message: str):
        clean = message
        for key in SECRETS:
            if self.config.get(key):
                clean = clean.replace(self.config[key], '[redacted]')
        clean = re.sub(r'sk-[\w-]+', '[redacted]', clean)
        clean = re.sub(r'\d{5,}:[\w-]{20,}', '[redacted]', clean)
        self._log_id += 1
        item = {'id': self._log_id, 'time': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
                'level': level, 'message': clean[:500]}
        self.logs.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:
                self.subscribers.discard(queue)

    def notes_path(self, chat_id: str, message_id: int) -> Path:
        if not re.fullmatch(r'-?\d+', chat_id) or not isinstance(message_id, int) or message_id < 1:
            raise ValueError('Invalid education document ID.')
        return self.dir / 'education-notes' / f'{chat_id}_{message_id}.txt.gz'

    async def save_education_notes(self, chat_id: str, message_id: int, notes: str):
        target = self.notes_path(chat_id, message_id)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = target.with_name(target.name + '.' + uuid4().hex + '.tmp')
        try:
            temp.write_bytes(gzip.compress(notes.encode()))
            os.chmod(temp, 0o600)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        await self.prune_education_notes()

    async def read_education_notes(self, chat_id: str, message_id: int) -> str | None:
        target = self.notes_path(chat_id, message_id)
        try:
            info = target.stat()
            if info.st_mtime * 1000 < time.time() * 1000 - 30 * DAY_MS or info.st_size > 2 * 1024 * 1024:
                return None
            return gzip.decompress(target.read_bytes()).decode()
        except FileNotFoundError:
            return None

    async def prune_education_notes(self):
        directory = self.dir / 'education-notes'
        if not directory.exists():
            return
        cutoff = time.time() - 30 * 86400
        for file in directory.iterdir():
            if re.fullmatch(r'-?\d+_\d+\.txt\.gz', file.name):
                try:
                    if file.stat().st_mtime < cutoff:
                        file.unlink(missing_ok=True)
                except FileNotFoundError:
                    pass

    def images_dir(self, chat_id: str, message_id: int) -> Path:
        self.notes_path(chat_id, message_id)
        return self.dir / 'education-images' / f'{chat_id}_{message_id}'

    async def save_education_images(self, chat_id: str, message_id: int, images: list[bytes]):
        from .education_images import MAX_EDUCATION_IMAGES, MAX_STORED_IMAGE
        if len(images) > MAX_EDUCATION_IMAGES or any(len(image) > MAX_STORED_IMAGE for image in images):
            raise ValueError('Too many or too large education images.')
        directory = self.images_dir(chat_id, message_id)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for index, image in enumerate(images, 1):
            target = directory / f'{index}.jpg'
            temp = directory / f'{index}.{uuid4().hex}.tmp'
            try:
                temp.write_bytes(image)
                os.chmod(temp, 0o600)
                os.replace(temp, target)
            finally:
                temp.unlink(missing_ok=True)
        for old in directory.glob('*.jpg'):
            if old.stem.isdigit() and int(old.stem) > len(images):
                old.unlink(missing_ok=True)
        await self.prune_education_images()

    async def read_education_images(self, chat_id: str, message_id: int) -> list[bytes]:
        from .education_images import MAX_EDUCATION_IMAGES, MAX_STORED_IMAGE
        directory = self.images_dir(chat_id, message_id)
        if not directory.exists() or directory.stat().st_mtime < time.time() - 30 * 86400:
            return []
        result = []
        for index in range(1, MAX_EDUCATION_IMAGES + 1):
            target = directory / f'{index}.jpg'
            if not target.exists() or target.stat().st_size > MAX_STORED_IMAGE:
                break
            result.append(target.read_bytes())
        return result

    async def prune_education_images(self):
        import shutil
        root = self.dir / 'education-images'
        if root.exists():
            for directory in root.iterdir():
                if directory.is_dir() and re.fullmatch(r'-?\d+_\d+', directory.name) and directory.stat().st_mtime < time.time() - 30 * 86400:
                    shutil.rmtree(directory)
