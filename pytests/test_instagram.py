import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from pybackend import instagram
from pybackend.audio import AudioService
from pybackend.errors import AppError
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def test_instagram_links():
    link = 'https://www.instagram.com/reel/Ab_123/'
    assert instagram.instagram_links({'text': f'🎬 ({link}?igsh=tracking) {link}'}) == [link]
    assert instagram.instagram_links({'caption': 'instagram.com/p/Video-1/'}) == ['https://www.instagram.com/p/Video-1/']
    assert instagram.instagram_links({'entities': [{'type': 'text_link', 'url': link}]}) == [link]
    for bad in ('https://instagram.com.evil.test/reel/a/', 'https://evil.test/instagram.com/reel/a/',
                'https://instagram.com@127.0.0.1/reel/a/', 'https://instagram.com/someuser/',
                'https://instagram.com/reels/audio/123/', 'https://instagram.com:8080/reel/a/'):
        assert instagram.instagram_links({'text': bad}) == []


@pytest.mark.parametrize('outcome', ['success', 'error', 'oversize', 'timeout', 'cancel'])
def test_download_cleanup(tmp_path, monkeypatch, outcome):
    created = []
    class Process:
        returncode = None
        killed = False

        def kill(self):
            self.killed = True
            self.returncode = -9

        async def wait(self):
            return self.returncode

    process = Process()
    async def launch(*args, **kwargs):
        video = Path(args[args.index('--output') + 1].replace('%(ext)s', 'mp4'))
        created.append(video)
        if outcome in ('success', 'oversize'):
            video.write_bytes(b'video')
            process.returncode = 0
        elif outcome == 'error':
            process.returncode = 1
        return process

    monkeypatch.setattr(instagram.asyncio, 'create_subprocess_exec', launch)
    monkeypatch.setattr(instagram, 'DOWNLOAD_TIMEOUT', 0.01)
    if outcome == 'oversize':
        monkeypatch.setattr(instagram, 'MAX_VIDEO_BYTES', 2)

    async def scenario():
        async def download():
            async with instagram.download_video('https://www.instagram.com/reel/Ab_123/') as path:
                assert path.read_bytes() == b'video'
        if outcome == 'cancel':
            task = asyncio.create_task(download())
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        elif outcome == 'success':
            await download()
        else:
            with pytest.raises(AppError):
                await download()
        assert created and not created[0].parent.exists()
        if outcome in ('timeout', 'cancel'):
            assert process.killed
    asyncio.run(scenario())


def test_link_message_upload_and_failure(tmp_path, monkeypatch):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService())
        bot.reply = AsyncMock()
        uploaded = []
        @asynccontextmanager
        async def download(link):
            file = tmp_path / 'video.mp4'
            file.write_bytes(b'original video')
            try:
                yield file
            finally:
                file.unlink()
        async def upload(client, method, url, **kwargs):
            assert url.endswith('/sendVideo')
            assert kwargs['files']['video'][1].read() == b'original video'
            uploaded.append(kwargs['data'])
            return {'ok': True}
        monkeypatch.setattr('pybackend.telegram.download_video', download)
        monkeypatch.setattr('pybackend.telegram.request_json', upload)
        message = {'message_id': 7, 'chat': {'id': 42, 'type': 'private'},
                   'from': {'id': 42, 'first_name': 'User'},
                   'text': 'https://instagram.com/reel/Ab_123/'}
        try:
            await bot.handle('test-token', message, store.config)
            assert uploaded[0]['chat_id'] == '42'
            assert '"message_id": 7' in uploaded[0]['reply_parameters']
            assert not (tmp_path / 'video.mp4').exists()
            assert store.state['chats']['42']['history'][-1]['text'] == message['text']
            monkeypatch.setattr('pybackend.telegram.request_json', AsyncMock(side_effect=AppError('failure', 502)))
            await bot.handle('test-token', message, store.config)
            bot.reply.assert_awaited_once()
            assert not (tmp_path / 'video.mp4').exists()
        finally:
            await bot.close()
    asyncio.run(scenario())
