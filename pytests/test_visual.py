import asyncio
import io
import os
import time
from unittest.mock import AsyncMock
from PIL import Image

os.environ['ADMIN_PASSWORD'] = 'abcdefghijklmnop'
os.environ['COOKIE_SECURE'] = 'false'
from pybackend.audio import AudioService
from pybackend.store import Store
from pybackend.telegram import TelegramBot
from pybackend.visual import frames_from_media, describe_visual


def run(coro):
    return asyncio.run(coro)


def message(chat_id, message_id, *, text=None, sticker=None, animation=None, video=None, document=None, user_id=10, kind='supergroup'):
    result = {'chat': {'id': chat_id, 'type': kind, 'title': f'Chat {chat_id}'},
              'message_id': message_id, 'date': int(time.time()),
              'from': {'id': user_id, 'first_name': 'User'}}
    if text is not None: result['text'] = text
    if sticker: result['sticker'] = sticker
    if animation: result['animation'] = animation
    if video: result['video'] = video
    if document: result['document'] = document
    return result


def test_default_off_admin_only_and_chat_isolation(tmp_path, monkeypatch):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        store.config['chatGptApiKey'] = 'test-key'
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        sent = []
        async def fake_call(token, method, data=None, timeout=None):
            if method == 'getChatMember':
                return {'status': 'administrator' if data['user_id'] == 10 else 'member'}
            if method == 'sendMessage':
                sent.append((data['chat_id'], data['text'], data['reply_parameters']['message_id']))
                return {'message_id': len(sent) + 100}
            if method == 'getChatMemberCount': return 3
            return True
        bot.call = fake_call
        bot.download_visual = AsyncMock(return_value=b'fake-image')
        describe = AsyncMock(return_value='گربهٔ خندان')
        monkeypatch.setattr('pybackend.telegram.describe_visual', describe)
        monkeypatch.setattr('pybackend.telegram.frames_from_media', AsyncMock(return_value=[b'jpeg']))
        sticker = {'file_id': 'sticker-id', 'emoji': '😺'}
        await bot.handle('token', message(-1, 1, sticker=sticker), store.config)
        assert not sent and not describe.await_count
        await bot.handle('token', message(-1, 2, text='/describe on', user_id=11), store.config)
        assert store.state['chats']['-1']['describeMedia'] is False
        await bot.handle('token', message(-1, 3, text='/describe on'), store.config)
        assert store.state['chats']['-1']['describeMedia'] is True
        await bot.handle('token', message(-2, 4, sticker=sticker), store.config)
        await bot.handle('token', message(-1, 5, video={'file_id': 'ordinary-video'}), store.config)
        assert describe.await_count == 0
        await bot.handle('token', message(-1, 6, sticker=sticker), store.config)
        await bot.handle('token', message(-1, 7, animation={'file_id': 'gif-id', 'duration': 2}), store.config)
        await bot.handle('token', message(-1, 8, document={'file_id': 'gif-document', 'mime_type': 'image/gif'}), store.config)
        assert describe.await_count == 3
        assert store.state['metrics']['stickersDescribed'] == 1
        assert [item[1] for item in sent[-3:]] == ['گربهٔ خندان'] * 3
        assert [item[2] for item in sent[-3:]] == [6, 7, 8]
        await bot.handle('token', message(-1, 9, text='/describe off'), store.config)
        await bot.handle('token', message(-1, 10, sticker=sticker), store.config)
        assert describe.await_count == 3
        assert store.state['metrics']['stickersDescribed'] == 1
        assert store.state['chats']['-1']['describeMedia'] is False
        await store.save_state()
        restored = Store(tmp_path)
        await restored.init()
        assert restored.state['chats']['-1']['describeMedia'] is False
        assert restored.state['chats']['-2']['describeMedia'] is False
        await bot.close()
    run(scenario())


def test_private_chat_can_enable_and_tgs_uses_emoji_without_thumbnail(tmp_path, monkeypatch):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        store.config['chatGptApiKey'] = 'test-key'
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        sent = []
        async def fake_call(token, method, data=None, timeout=None):
            if method == 'sendMessage': sent.append(data['text']); return {'message_id': 100}
            return True
        bot.call = fake_call
        bot.download_visual = AsyncMock()
        describe = AsyncMock(return_value='صورتک خندان')
        monkeypatch.setattr('pybackend.telegram.describe_visual', describe)
        await bot.handle('token', message(2, 1, text='/describe on', kind='private'), store.config)
        await bot.handle('token', message(2, 2, sticker={'file_id':'tgs', 'is_animated':True, 'emoji':'😀'}, kind='private'), store.config)
        assert sent[-1] == 'صورتک خندان'
        assert store.state['metrics']['stickersDescribed'] == 1
        describe.return_value = 'smiling face'
        await bot.handle('token', message(2, 3, sticker={'file_id':'tgs', 'is_animated':True, 'emoji':'😀'}, kind='private'), store.config)
        assert store.state['metrics']['stickersDescribed'] == 1
        assert describe.await_args.args[1] == []
        bot.download_visual.assert_not_awaited()
        await bot.close()
    run(scenario())


def test_failed_sticker_description_does_not_increase_stats(tmp_path, monkeypatch):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        store.config['chatGptApiKey'] = 'test-key'
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        sent = []
        async def fake_call(_token, method, data=None, timeout=None):
            if method == 'sendMessage':
                sent.append(data['text'])
                return {'message_id': 100}
            return True
        bot.call = fake_call
        monkeypatch.setattr('pybackend.telegram.describe_visual', AsyncMock(side_effect=RuntimeError('provider failed')))
        bot.download_visual = AsyncMock(return_value=b'fake-image')
        monkeypatch.setattr('pybackend.telegram.frames_from_media', AsyncMock(return_value=[b'jpeg']))
        await bot.handle('token', message(2, 1, text='/describe on', kind='private'), store.config)
        await bot.handle('token', message(2, 2, sticker={'file_id': 'sticker-id'}, kind='private'), store.config)
        assert store.state['metrics']['stickersDescribed'] == 0
        assert 'ممکن نشد' in sent[-1]
        await bot.close()
    run(scenario())


def test_frame_extraction_and_luna_request(monkeypatch):
    async def scenario():
        image = Image.new('RGBA', (30, 30), 'red')
        output = io.BytesIO()
        image.save(output, 'PNG')
        frames = await frames_from_media(output.getvalue())
        assert len(frames) == 1 and frames[0].startswith(b'\xff\xd8')
        sent = {}
        async def fake_request(client, method, url, **kwargs):
            sent.update(method=method, url=url, body=kwargs['json'])
            return {'choices': [{'message': {'content': 'گربهٔ خندان'}}]}
        monkeypatch.setattr('pybackend.visual.request_json', fake_request)
        config = {'chatGptBaseUrl':'https://router.wizdin.xyz/v1', 'chatGptApiKey':'test-key'}
        assert await describe_visual(config, frames, 'sticker', '😺') == 'گربهٔ خندان'
        assert sent['body']['model'] == 'cx/gpt-6-luna(low)'
        assert sent['body']['max_completion_tokens'] == 300
        assert sent['body']['messages'][1]['content'][1]['image_url']['detail'] == 'low'
    run(scenario())
