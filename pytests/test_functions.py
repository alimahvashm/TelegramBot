import asyncio
import os
import subprocess
import time
from pathlib import Path
from unittest.mock import AsyncMock
import pytest

os.environ['ADMIN_PASSWORD'] = 'abcdefghijklmnop'
os.environ['COOKIE_SECURE'] = 'false'
from pybackend.audio import AudioService
from pybackend.config import Config, summary_count
from pybackend import providers
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def run(coro):
    return asyncio.run(coro)


def test_summary_default_and_override():
    assert summary_count(None) == 50
    assert summary_count('') == 50
    assert summary_count('25') == 25
    assert summary_count('100') == 100


def test_provider_tasks_and_long_notes(monkeypatch):
    calls = []
    async def fake_generate(config, system, content, max_tokens, task, log=lambda msg: None):
        calls.append((task, content))
        return {'text': 'پاسخ مدل', 'provider': 'mock', 'model': 'mock', 'fallback': False, 'durationMs': 1}
    monkeypatch.setattr(providers, 'generate_text', fake_generate)
    config = Config().model_dump()
    async def scenario():
        summary = await providers.summarize(config, [{'sender':'A','timestamp':int(time.time()*1000),'text':'موضوع'}])
        assert summary['text'] == 'پاسخ مدل'
        notes = await providers.create_education_notes(config, ('این متن تدریس است. ' * 1800))
        assert 'بخش 1' in notes['text'] and 'بخش 2' in notes['text']
        answer = await providers.answer_education_question(config, 'این جزوه است', 'چه چیزی؟')
        assert answer['text'] == 'پاسخ مدل'
        image = await providers.describe_education_image(config, b'\xff\xd8\xffdata', 'image/jpeg')
        assert image['text'] == 'پاسخ مدل'
        assert {task for task, _ in calls} == {'summary', 'education', 'question', 'image'}
    run(scenario())


def test_audio_conversion_and_segmentation(monkeypatch):
    if not __import__('shutil').which('ffmpeg') or not __import__('shutil').which('ffprobe'):
        pytest.skip('FFmpeg not installed')
    wav = subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=1.2', '-ar', '16000', '-f', 'wav', 'pipe:1'])
    seen = []
    async def fake_transcribe(config, wav_path, flac_path, language):
        seen.append((wav_path.read_bytes()[:4], language))
        return 'متن آزمایشی'
    monkeypatch.setattr('pybackend.audio.transcribe', fake_transcribe)
    config = Config().model_dump()
    config['transcribeMode'] = 'fastapi'
    result = run(AudioService().process(wav, config, 'fa-IR', True))
    assert result['text'] == 'متن آزمایشی'
    assert result['segments'] == 1
    assert result['wavBase64']
    assert seen == [(b'RIFF', 'fa-IR')]


def test_education_question_and_image_command_flow(tmp_path, monkeypatch):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService(), pdf_renderer=AsyncMock(return_value=b'%PDF-mock'))
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        sent = []
        async def fake_call(token, method, data=None, timeout=None):
            sent.append((method, data))
            if method == 'sendMessage': return {'message_id': 800}
            if method == 'getFile': return {'file_path': 'photo.jpg', 'file_size': 10}
            return True
        bot.call = fake_call
        bot.send_pdf = AsyncMock(return_value=700)
        bot.edit_pdf = AsyncMock()
        bot.transcribe_media = AsyncMock(return_value='متن کلاس')
        monkeypatch.setattr('pybackend.telegram.create_education_notes', AsyncMock(return_value={'text':'جزوهٔ خوب','provider':'mock'}))
        monkeypatch.setattr('pybackend.telegram.answer_education_question', AsyncMock(return_value={'text':'پاسخ جزوه'}))
        monkeypatch.setattr('pybackend.telegram.describe_education_image', AsyncMock(return_value={'text':'مطالب تصویر'}))
        class Download:
            status_code = 200
            headers = {}
            content = b'\xff\xd8\xffdata'
        bot.client.get = AsyncMock(return_value=Download())
        def message(mid, text, source=None, photo=None):
            value = {'chat': {'id': -123, 'type': 'supergroup', 'title': 'Group'}, 'message_id': mid,
                     'date': int(time.time()), 'from': {'id': 2, 'first_name': 'A'}, 'text': text}
            if source: value['reply_to_message'] = source
            if photo: value['photo'] = photo
            return value
        config = store.config
        source_audio = {'message_id': 1, 'voice': {'file_id': 'voice'}}
        await bot.handle('token', message(2, '/education', source_audio), config)
        assert await store.read_education_notes('-123', 700) == 'جزوهٔ خوب'
        source_pdf = {'message_id': 700, 'document': {'file_name': 'education-notes.pdf'}, 'from': {'id': 999}}
        await bot.handle('token', message(3, '/question چی؟', source_pdf), config)
        assert any(method == 'editMessageText' and data['text'] == 'پاسخ جزوه' for method, data in sent)
        image_message = message(4, '/image', source_pdf, [{'file_id': 'image', 'file_size': 10}])
        await bot.handle('token', image_message, config)
        assert 'مطالب تصویر' in await store.read_education_notes('-123', 700)
        bot.edit_pdf.assert_awaited_once()
        await bot.close()
    run(scenario())
