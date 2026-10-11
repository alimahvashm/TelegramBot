import asyncio
import json
import time
import pytest

from pybackend import gpt
from pybackend.audio import AudioService
from pybackend.store import Store


def run(coro):
    return asyncio.run(coro)


def test_gpt_starts_with_twenty_and_fetches_older_messages(monkeypatch):
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
    history = [{'messageId': n, 'timestamp': n * 1000, 'sender': 'A', 'text': f'Message {n}'}
               for n in range(1, 26)]
    answer = run(gpt.answer_chat_question({'chatGptApiKey': 'test-key',
        'chatGptBaseUrl': 'https://api.openai.com/v1'}, 'What was said earlier?', history))
    assert answer == 'The earlier answer was 42.'
    assert requests[0]['model'] == 'gpt-4.1-nano'
    initial = json.loads(requests[0]['messages'][1]['content'])
    assert [m['messageId'] for m in initial['recent_messages']] == list(range(6, 26))
    assert initial['older_before'] == 5
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
    assert requests[0]['model'] == 'cx/gpt-5.6-luna'


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

        async def fake_answer(_config, question, history):
            assert question == 'What happened?'
            assert [item['text'] for item in history] == ['Private context']
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
