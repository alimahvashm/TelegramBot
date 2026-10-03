import asyncio
import json
import time
from unittest.mock import AsyncMock

from pybackend.audio import AudioService
from pybackend.profile import ProfileArchive, _validated_card, generate_profile
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def run(coro):
    return asyncio.run(coro)


def test_profile_archive_is_capped_and_isolated(tmp_path):
    archive = ProfileArchive(tmp_path)
    for index in range(1, 503):
        archive.remember('-1', '5', index, index, f'message {index}')
    archive.remember('-2', '5', 1, 1, 'other group')
    archive.remember('-1', '6', 1, 1, 'other user')
    own = archive.recent('-1', '5')
    assert len(own) == 500
    assert own[0]['id'] == '3' and own[-1]['id'] == '502'
    archive.forget('-1', '5')
    assert archive.recent('-1', '5') == []
    assert archive.recent('-2', '5')[0]['text'] == 'other group'
    assert archive.recent('-1', '6')[0]['text'] == 'other user'


def test_profile_opt_in_target_and_revoke(tmp_path, monkeypatch):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        sent = []
        async def fake_call(_token, method, data=None, timeout=None):
            if method == 'sendMessage':
                sent.append(data['text'])
                return {'message_id': 900}
            return 2
        bot.call = fake_call
        generate = AsyncMock(return_value={field: None for field in ('chat_personality', 'social_orientation', 'attractive_trait', 'annoying_trait', 'superpower', 'nickname')})
        monkeypatch.setattr('pybackend.telegram.generate_profile', generate)
        def msg(chat_id, mid, uid, text, username=''):
            return {'chat': {'id': chat_id, 'type': 'supergroup', 'title': 'Group'}, 'message_id': mid,
                    'date': int(time.time()), 'from': {'id': uid, 'first_name': 'User', 'username': username}, 'text': text}
        await bot.handle('token', msg(-1, 1, 5, 'before consent', 'target5'), store.config)
        assert bot.profile_archive.recent('-1', '5') == []
        await bot.handle('token', msg(-1, 2, 6, '/profile 5'), store.config)
        assert 'رضایت نداده' in sent[-1]
        await bot.handle('token', msg(-1, 3, 5, '/profile on', 'target5'), store.config)
        await bot.handle('token', msg(-1, 4, 5, 'after consent', 'target5'), store.config)
        await bot.handle('token', msg(-2, 1, 5, 'another group', 'target5'), store.config)
        await bot.handle('token', msg(-1, 5, 6, '/profile @target5'), store.config)
        assert generate.await_args.args[1] == '5'
        assert [item['text'] for item in generate.await_args.args[2]] == ['after consent']
        await bot.handle('token', msg(-1, 6, 5, '/profile off', 'target5'), store.config)
        assert bot.profile_archive.recent('-1', '5') == []
        await bot.handle('token', msg(-1, 7, 6, '/profile 5'), store.config)
        assert 'رضایت نداده' in sent[-1]
        await bot.close()
    run(scenario())


def test_profile_uses_sol_medium_and_rejects_invented_evidence(monkeypatch):
    observed = {}
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
    async def fake_request(_client, _method, _url, **kwargs):
        observed.update(kwargs['json'])
        card = {'status': 'ok', 'chat_personality': {'text': 'کنجکاوی', 'basis': 'tentative_interpretation', 'reason': 'شاهد', 'evidence_ids': ['999']}}
        return {'choices': [{'message': {'content': json.dumps(card)}}]}
    monkeypatch.setattr('pybackend.profile.httpx.AsyncClient', FakeClient)
    monkeypatch.setattr('pybackend.profile.request_json', fake_request)
    config = {'chatGptApiKey': 'test', 'chatGptBaseUrl': 'https://router.wizdin.xyz/v1'}
    card = run(generate_profile(config, '5', [{'id':'1','author_id':'5','timestamp':1,'text':'سلام'}]))
    assert observed['model'] == 'cx/gpt-6.1-sol(medium)'
    assert observed['reasoning_effort'] == 'medium'
    assert card['chat_personality'] is None
    assert json.loads(observed['messages'][1]['content'])['analysis_authorized'] is True


def test_chat_history_keeps_latest_2000(tmp_path):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        chat = {'history': []}
        for mid in range(1, 2003):
            store.remember(chat, {'messageId': mid, 'timestamp': 1, 'sender': 'A', 'text': 'x'})
        assert len(chat['history']) == 2000
        assert chat['history'][0]['messageId'] == 3
        store.state['chats']['1'] = chat
        store.prune()
        assert len(chat['history']) == 2000
    run(scenario())
