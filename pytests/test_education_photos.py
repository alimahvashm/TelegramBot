import asyncio
import io
import time
from unittest.mock import AsyncMock

from PIL import Image

from pybackend.audio import AudioService
from pybackend.pdf import education_html
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def test_captioned_album_uses_photos_in_notes_and_pdf(tmp_path, monkeypatch):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        renderer = AsyncMock(return_value=b'%PDF-mock')
        bot = TelegramBot(store, AudioService(), pdf_renderer=renderer)
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        calls = []
        async def fake_call(token, method, data=None, timeout=None):
            if method == 'sendMessage': return {'message_id': 800}
            if method == 'getFile': return {'file_path': 'photo.jpg', 'file_size': 100}
            return True
        bot.call = fake_call
        bot.send_pdf = AsyncMock(return_value=700)
        bot.transcribe_media = AsyncMock(return_value='متن کلاس')
        async def fake_description(config, image, mime, log):
            return {'text': 'نمودار درس'}
        async def fake_notes(config, transcript, log, progress):
            calls.append(transcript)
            return {'text': 'جزوهٔ مرتب', 'provider': 'mock'}
        monkeypatch.setattr('pybackend.telegram.describe_education_image', fake_description)
        monkeypatch.setattr('pybackend.telegram.create_education_notes', fake_notes)
        monkeypatch.setattr('pybackend.telegram.asyncio.sleep', AsyncMock())
        image = Image.new('RGB', (100, 100), 'white')
        output = io.BytesIO(); image.save(output, format='JPEG')
        class Download:
            status_code = 200
            headers = {}
            content = output.getvalue()
        bot.client.get = AsyncMock(return_value=Download())
        source = {'message_id': 1, 'voice': {'file_id': 'voice'}}
        message = {'chat': {'id': -123, 'type': 'supergroup', 'title': 'Group'}, 'message_id': 2,
                   'date': int(time.time()), 'from': {'id': 2}, 'caption': '/education',
                   'reply_to_message': source, 'media_group_id': 'album',
                   'photo': [{'file_id': 'one', 'file_size': 100}]}
        second = {**message, 'message_id': 3, 'caption': '', 'photo': [{'file_id': 'two', 'file_size': 100}]}
        bot.remember_album_photo(second)
        await bot.handle('token', message, store.config)
        assert 'نمودار درس' in calls[0]
        assert len(renderer.await_args.args[1]) == 2
        saved = await store.read_education_images('-123', 700)
        assert len(saved) == 2
        assert 'data:image/jpeg;base64,' in education_html('جزوهٔ مرتب', saved)
        await bot.close()
    asyncio.run(scenario())
