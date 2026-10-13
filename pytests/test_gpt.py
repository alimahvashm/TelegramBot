import asyncio
import json
import time
from unittest.mock import AsyncMock
import pytest

from pybackend import gpt
from pybackend.audio import AudioService
from pybackend.store import Store


def run(coro):
    return asyncio.run(coro)


def test_gpt_starts_with_fifty_and_fetches_older_messages(monkeypatch):
    requests = []

    async def fake_request(_client, _method, _url, **kwargs):
        payload = kwargs['json']
        requests.append(payload)
        if len(requests) == 1:
            return {'choices': [{'message': {'content': None, 'tool_calls': [{
                'id': 'call-1', 'type': 'function', 'function': {
                    'name': 'get_older_messages', 'arguments': json.dumps({'before': 5})}}]},
                'finish_reason': 'tool_calls'}]}
        return {'choices': [{'message': {'content': 'The earlier answer was 42.'}, 'finish_reason': 'stop'}]}

    monkeypatch.setattr(gpt, 'request_json', fake_request)
    monkeypatch.delenv('GPT_MODEL', raising=False)
    history = [{'messageId': n, 'timestamp': n * 1000, 'sender': 'A', 'authorId': '42', 'text': f'Message {n}'}
               for n in range(1, 56)]
    asker = {'id': '42', 'name': 'A', 'username': 'asker'}
    answer = run(gpt.answer_chat_question({'chatGptApiKey': 'test-key',
        'chatGptBaseUrl': 'https://api.openai.com/v1'}, 'What was said earlier?', history, asker=asker))
    assert answer == 'The earlier answer was 42.'
    assert requests[0]['model'] == 'gpt-4.1-nano'
    initial = json.loads(requests[0]['messages'][1]['content'])
    assert [m['messageId'] for m in initial['recent_messages']] == list(range(6, 56))
    assert initial['older_before'] == 5
    assert initial['asker'] == asker
    assert all(item['authorId'] == '42' for item in initial['recent_messages'])
    fetched = json.loads(requests[1]['messages'][-1]['content'])
    assert [m['messageId'] for m in fetched['messages']] == list(range(1, 6))
    assert fetched['has_more'] is False


def test_gpt_can_search_all_stored_older_messages():
    history = [{'messageId': n, 'sender': 'A', 'timestamp': n, 'text': f'Message {n}'}
               for n in range(1, 1981)]
    history[1]['text'] = 'Earlier discussion about the blue notebook'
    result = gpt._tool_result('search_history', {'query': 'blue notebook'}, history)
    assert result['total_matches'] == 1
    assert result['matches'][0]['messageId'] == 2


def test_gpt_uses_available_custom_router_model(monkeypatch):
    requests = []

    async def fake_request(_client, _method, _url, **kwargs):
        requests.append(kwargs['json'])
        return {'choices': [{'message': {'content': 'OK'}, 'finish_reason': 'stop'}]}

    monkeypatch.setattr(gpt, 'request_json', fake_request)
    monkeypatch.delenv('GPT_MODEL', raising=False)
    answer = run(gpt.answer_chat_question({'chatGptApiKey': 'test-key',
        'chatGptBaseUrl': 'https://router.example/v1'}, 'Say OK', []))
    assert answer == 'OK'
    assert requests[0]['model'] == 'cx/gpt-6-sol(low)'


def test_gpt_includes_replied_message_outside_recent_fifty(monkeypatch):
    requests = []

    async def fake_request(_client, _method, _url, **kwargs):
        requests.append(kwargs['json'])
        return {'choices': [{'message': {'content': 'It means blue.'}, 'finish_reason': 'stop'}]}

    monkeypatch.setattr(gpt, 'request_json', fake_request)
    history = [{'messageId': n, 'timestamp': n * 1000, 'sender': 'A', 'text': f'Message {n}'}
               for n in range(1, 56)]
    reply = {'messageId': 1, 'sender': 'A', 'text': 'The code word is blue.', 'mediaType': None}
    answer = run(gpt.answer_chat_question({'chatGptApiKey': 'test-key',
        'chatGptBaseUrl': 'https://router.example/v1'}, 'What does this mean?', history, reply))
    prompt = json.loads(requests[0]['messages'][1]['content'])
    assert answer == 'It means blue.'
    assert prompt['question'] == 'What does this mean?'
    assert prompt['replied_to_message'] == reply
    assert all(item['messageId'] != 1 for item in prompt['recent_messages'])


def test_gpt_command_uses_only_its_chat_and_remembers_answer(tmp_path, monkeypatch):
    pytest.importorskip('PIL')
    from pybackend.telegram import TelegramBot
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 99, 'username': 'testbot'}
        sent = []

        async def fake_call(_token, method, data=None, timeout=None):
            sent.append((method, data))
            return {'message_id': 100 + len(sent)} if method == 'sendMessage' else True

        async def fake_answer(_config, question, history, reply_to, asker):
            assert question == 'What happened?'
            assert [item['text'] for item in history] == ['Private context']
            assert reply_to is None
            assert asker == {'id': '1', 'name': 'User', 'username': None}
            return 'Here is the answer.'

        monkeypatch.setattr('pybackend.telegram.answer_chat_question', fake_answer)
        bot.call = fake_call

        def message(chat_id, mid, text):
            return {'chat': {'id': chat_id, 'type': 'private'}, 'message_id': mid,
                    'date': int(time.time()), 'from': {'id': chat_id, 'first_name': 'User'}, 'text': text}

        await bot.handle('token', message(2, 1, 'Another chat secret'), store.config)
        await bot.handle('token', message(1, 1, 'Private context'), store.config)
        await bot.handle('token', message(1, 2, '/gpt What happened?'), store.config)
        assert any(method == 'sendMessage' and data['text'] == 'Here is the answer.' for method, data in sent)
        assert [item['text'] for item in store.state['chats']['1']['history']] == [
            'Private context', 'What happened?', 'Here is the answer.']
        await bot.close()

    run(scenario())


def test_gpt_reply_command_passes_quoted_message_and_question(tmp_path, monkeypatch):
    pytest.importorskip('PIL')
    from pybackend.telegram import TelegramBot

    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 99, 'username': 'testbot'}
        bot.call = AsyncMock(return_value={'message_id': 100})
        captured = []

        async def fake_answer(_config, question, history, reply_to, asker):
            captured.append((question, history, reply_to, asker))
            return 'It refers to the older message.'

        monkeypatch.setattr('pybackend.telegram.answer_chat_question', fake_answer)
        source = {'message_id': 1, 'date': int(time.time()) - 100,
                  'from': {'id': 9, 'first_name': 'Alice'}, 'text': 'An older topic.'}
        message = {'chat': {'id': -1, 'type': 'supergroup', 'title': 'Group'},
                   'message_id': 50, 'date': int(time.time()),
                   'from': {'id': 2, 'first_name': 'Bob', 'username': 'bob'},
                   'text': '/gpt What does this mean?', 'reply_to_message': source}
        await bot.handle('token', message, store.config)
        assert captured[0][0] == 'What does this mean?'
        assert captured[0][2] == {'messageId': 1, 'sender': 'Alice',
                                  'text': 'An older topic.', 'mediaType': None}
        assert captured[0][3] == {'id': '2', 'name': 'Bob', 'username': 'bob'}
        assert captured[0][1] == []
        await bot.close()

    run(scenario())
