import asyncio
import gzip
import os
import time
import sys
from pathlib import Path
import httpx
import pytest

os.environ['ADMIN_PASSWORD'] = 'abcdefghijklmnop'
os.environ['COOKIE_SECURE'] = 'false'
from pybackend.app import create_app
from pybackend.audio import AudioService
from pybackend.config import merge_config, public_config
from pybackend.pdf import render_education_pdf
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def run(coro):
    return asyncio.run(coro)


def test_dashboard_auth_config_and_state(tmp_path):
    async def scenario():
        store = Store(tmp_path)
        bot = TelegramBot(store, AudioService())
        app = create_app(store, bot, password='abcdefghijklmnop', start_bot=False)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
                assert (await client.get('/healthz')).json() == {'ok': True}
                assert (await client.get('/api/bot/config')).status_code == 401
                assert (await client.post('/api/auth/login', json={'password': 'wrong'})).status_code == 401
                assert (await client.post('/api/auth/login', json={'password': 'abcdefghijklmnop'})).status_code == 200
                response = await client.post('/api/bot/config', json={'educationSystemPrompt': 'جزوهٔ مرتب', 'chatGptApiKey': 'secret', 'polishTranscript': False})
                assert response.status_code == 200
                assert response.json()['config']['chatGptApiKey'] == '••••••••'
                assert response.json()['config']['educationSystemPrompt'] == 'جزوهٔ مرتب'
                assert response.json()['config']['polishTranscript'] is False
                assert (await client.post('/api/bot/config', json={'unknown': True})).status_code == 400
                assert (await client.post('/api/bot/config', json={'language': 'invalid'})).status_code == 400
                assert (await client.get('/api/bot/audience')).status_code == 200
                assert (await client.post('/api/auth/logout')).status_code == 200
                assert (await client.get('/api/bot/config')).status_code == 401
        await store.init()
        assert store.config['educationSystemPrompt'] == 'جزوهٔ مرتب'
        assert store.config['chatGptApiKey'] == 'secret'
        assert store.config['polishTranscript'] is False
    run(scenario())


def test_existing_persisted_notes_and_config(tmp_path):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        await store.save_education_notes('-123', 55, 'متن درس')
        assert gzip.decompress((tmp_path / 'education-notes/-123_55.txt.gz').read_bytes()).decode() == 'متن درس'
        assert await store.read_education_notes('-123', 55) == 'متن درس'
        config = merge_config(store.config, {'chatGptApiKey': 'secret'})
        assert public_config(config)['chatGptApiKey'] != 'secret'
        assert merge_config(config, {'chatGptApiKey': ''})['chatGptApiKey'] == 'secret'
        assert merge_config(config, {'clearSecrets': ['chatGptApiKey']})['chatGptApiKey'] == ''
    run(scenario())


def test_pdf_statistics_are_per_chat_and_persist(tmp_path):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        group = {'id': '-123', 'title': 'Study group', 'type': 'supergroup', 'history': []}
        private = {'id': '456', 'title': 'A user', 'type': 'private', 'history': []}
        store.state['chats'] = {'-123': group, '456': private}
        store.record_pdf(group)
        store.record_pdf(group)
        store.record_pdf(private)
        await store.save_state()
        restored = Store(tmp_path)
        await restored.init()
        metrics = restored.state['metrics']
        assert (metrics['pdfsGenerated'], metrics['groupPdfs'], metrics['privatePdfs']) == (3, 2, 1)
        assert restored.state['chats']['-123']['pdfCount'] == 2
        assert restored.state['chats']['456']['pdfCount'] == 1
        assert restored.state['chats']['456']['lastPdfAt'] > 0
        app = create_app(restored, TelegramBot(restored, AudioService()), password='abcdefghijklmnop', start_bot=False)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
                await client.post('/api/auth/login', json={'password': 'abcdefghijklmnop'})
                audience = (await client.get('/api/bot/audience')).json()
                assert audience['metrics']['pdfsGenerated'] == 3
                assert {chat['id']: chat['pdfCount'] for chat in audience['chats']} == {'-123': 2, '456': 1}
    run(scenario())


@pytest.mark.skipif(sys.platform == "darwin", reason="WeasyPrint native libraries are installed in Linux Docker/CI")
def test_pdf_is_rendered(tmp_path):
    async def scenario():
        pdf = await render_education_pdf('فصل اول\n\nاین متن برای آموزش است.\n\n• نکته مهم')
        assert pdf.startswith(b'%PDF-')
        assert len(pdf) > 1000
    run(scenario())


def test_telegram_commands_and_independent_chats(tmp_path):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 100, 'username': 'testbot'}
        sent = []
        async def fake_call(_token, method, data=None, timeout=None):
            sent.append((method, data))
            if method == 'sendMessage':
                return {'message_id': len(sent) + 100}
            return True
        bot.call = fake_call
        config = store.config
        def message(chat_id, msg_id, text):
            return {'chat': {'id': chat_id, 'type': 'private'}, 'message_id': msg_id,
                    'date': int(time.time()), 'from': {'id': chat_id, 'first_name': 'User'}, 'text': text}
        await bot.handle('token', message(1, 1, 'Hello'), config)
        await bot.handle('token', message(2, 1, 'World'), config)
        assert store.state['chats']['1']['history'][0]['text'] == 'Hello'
        assert store.state['chats']['2']['history'][0]['text'] == 'World'
        await bot.handle('token', message(1, 2, '/start'), config)
        assert any(item[1] and 'Hello!' in item[1].get('text', '') for item in sent)
        await bot.close()
    run(scenario())
