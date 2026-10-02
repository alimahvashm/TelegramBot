import asyncio
import pytest
from unittest.mock import AsyncMock

from pybackend.config import Config
from pybackend.providers import polish_transcript


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize('base_url,model', [
    ('https://router.wizdin.xyz/v1', 'cx/gpt-6-sol(low)'),
    ('https://api.openai.com/v1', 'gpt-6-sol'),
])
def test_cleanup_returns_rewritten_transcript(monkeypatch, base_url, model):
    monkeypatch.delenv('TRANSCRIPT_POLISH_MODEL', raising=False)
    original = 'برای تمدید اغامت بایست یک درص پاس کنی نه دو درص'
    edited = 'برای تمدید اقامت باید ۱ درس را پاس کنی.\n\nنیازی به گذراندن ۲ درس نیست.'
    sent = {}
    async def fake_request(client, method, url, **kwargs):
        sent['url'] = url
        sent['body'] = kwargs['json']
        return {'choices': [{'message': {'content': edited}, 'finish_reason': 'stop'}]}
    monkeypatch.setattr('pybackend.providers.request_json', fake_request)
    config = Config().model_dump()
    config.update(chatGptApiKey='test-key', chatGptBaseUrl=base_url)
    assert run(polish_transcript(config, original)) == edited
    assert sent['body']['model'] == model
    assert sent['body']['reasoning_effort'] == 'low'
    assert sent['body']['messages'][1]['content'] == original
    assert sent['url'] == base_url + '/chat/completions'


def test_cleanup_falls_back_to_raw_text(monkeypatch):
    original = 'برای تمدید اقامت باید ۱ درس پاس کنی، نه ۲ درس.'
    config = Config().model_dump()
    config['chatGptApiKey'] = 'test-key'
    request = AsyncMock(return_value={'choices': [{'message': {'content': ''}}]})
    monkeypatch.setattr('pybackend.providers.request_json', request)
    assert run(polish_transcript(config, original)) == original
    config['polishTranscript'] = False
    assert run(polish_transcript(config, original)) == original
    assert request.await_count == 1

    config['polishTranscript'] = True
    request.side_effect = RuntimeError('provider unavailable')
    assert run(polish_transcript(config, original)) == original


@pytest.mark.parametrize('choice', [
    {'message': {'content': None}},
    {'message': {'content': 'متن ناقص'}, 'finish_reason': 'length'},
])
def test_cleanup_unusable_response_falls_back(monkeypatch, choice):
    config = Config().model_dump()
    config['chatGptApiKey'] = 'test-key'
    monkeypatch.setattr('pybackend.providers.request_json', AsyncMock(return_value={'choices': [choice]}))
    assert run(polish_transcript(config, 'متن اصلی')) == 'متن اصلی'
