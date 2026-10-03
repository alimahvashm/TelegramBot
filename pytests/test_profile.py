import asyncio
import json
import sqlite3
import time
from unittest.mock import AsyncMock

from pybackend.audio import AudioService
from pybackend.profile import LegacyProfileArchive, FIELDS, format_profile, generate_profile, group_profile_messages
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def run(coro):
    return asyncio.run(coro)


def test_legacy_profile_authors_are_used_only_for_matching_group(tmp_path):
    archive = LegacyProfileArchive(tmp_path)
    with sqlite3.connect(archive.path) as db:
        db.executemany('INSERT INTO messages VALUES (?,?,?,?,?)', [
            ('-1', '5', 1, 1, 'old message'), ('-2', '6', 1, 1, 'other group')])
    assert archive.legacy_authors('-1', 1) == {1: '5'}
    history = [{'messageId': 1, 'timestamp': 1, 'sender': 'A', 'text': 'old message'},
               {'messageId': 2, 'timestamp': 2, 'sender': 'B', 'text': 'unknown author'}]
    messages = group_profile_messages(history, archive.legacy_authors('-1', 1))
    assert [item['author_id'] for item in messages] == ['5', None]


def test_profile_username_uses_group_messages_without_activation(tmp_path, monkeypatch):
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
        await bot.handle('token', msg(-1, 1, 5, 'first message', 'target5'), store.config)
        await bot.handle('token', msg(-1, 2, 6, 'context from another member'), store.config)
        await bot.handle('token', msg(-1, 4, 5, 'second message', 'target5'), store.config)
        await bot.handle('token', msg(-2, 1, 5, 'another group', 'target5'), store.config)
        await bot.handle('token', msg(-1, 5, 6, '/profile @target5'), store.config)
        assert generate.await_args.args[1] == '5'
        assert [item['text'] for item in generate.await_args.args[2]] == ['first message', 'context from another member', 'second message']
        assert [item['author_id'] for item in generate.await_args.args[2]] == ['5', '6', '5']
        assert 'کارت گفتگویی' in sent[-1]
        assert store.state['metrics']['profilesGenerated'] == 1
        await bot.handle('token', msg(-1, 6, 6, '/profile unknown'), store.config)
        assert 'از /profile @username استفاده کن' in sent[-1]
        assert store.state['metrics']['profilesGenerated'] == 1
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
    config = {'chatGptApiKey': 'test', 'chatGptBaseUrl': 'https://router.wizdin.xyz/v1', 'profileSystemPrompt': 'پرامپت سفارشی کارت'}
    card = run(generate_profile(config, '5', [
        {'id':'1','author_id':'5','timestamp':1,'text':'سلام'},
        {'id':'2','author_id':'6','timestamp':2,'text':'جواب'}]))
    assert observed['model'] == 'cx/gpt-6-sol(medium)'
    assert observed['reasoning_effort'] == 'medium'
    assert observed['messages'][0]['content'].startswith('پرامپت سفارشی کارت')
    assert '۲۰۰۰ پیام اخیر همین گروه' in observed['messages'][0]['content']
    assert card['chat_personality'] is None
    assert 'analysis_authorized' not in json.loads(observed['messages'][1]['content'])
    assert len(json.loads(observed['messages'][1]['content'])['messages']) == 2


def test_profile_shows_all_fields_when_evidence_is_missing():
    card = {field: None for field in FIELDS}
    output = format_profile(card, '@target5', 2000, 650)
    assert output.count('شواهد کافی نیست') == 6
    assert '۲۰۰۰' not in output and '2000' in output


def test_profile_uses_all_2000_group_messages_and_checks_target_evidence(monkeypatch):
    observed = {}
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
    async def fake_request(_client, _method, _url, **kwargs):
        observed.update(kwargs['json'])
        card = {'status': 'ok', 'attractive_trait': {'text': 'فعال', 'basis': 'observed_pattern',
                'reason': 'دو پیام', 'evidence_ids': ['2000', '2001']}}
        return {'choices': [{'message': {'content': json.dumps(card)}}]}
    monkeypatch.setattr('pybackend.profile.httpx.AsyncClient', FakeClient)
    monkeypatch.setattr('pybackend.profile.request_json', fake_request)
    messages = [{'id': str(mid), 'author_id': '5' if mid % 2 else '6',
                 'timestamp': mid, 'text': 'پیام گروه ' * 40} for mid in range(1, 2003)]
    config = {'chatGptApiKey': 'test', 'chatGptBaseUrl': 'https://router.wizdin.xyz/v1',
              'profileSystemPrompt': 'پرامپت سفارشی کارت'}
    card = run(generate_profile(config, '5', messages))
    sent = json.loads(observed['messages'][1]['content'])['messages']
    assert len(sent) == 2000
    assert sent[0]['id'] == '3' and sent[-1]['id'] == '2002'
    assert sum(item['author_id'] == '5' for item in sent) == 1000
    assert card['attractive_trait'] is None  # Message 2000 belongs to another user.


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
