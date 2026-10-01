import asyncio
from unittest.mock import AsyncMock

from pybackend.config import Config
from pybackend.providers import polish_is_safe, polish_transcript


def run(coro):
    return asyncio.run(coro)


def test_cleanup_accepts_light_punctuation_and_rejects_fact_changes(monkeypatch):
    original = 'سلام خوب هستی وقتت بخیر باشه من درباره دانشگاه ایتالیا بگم باید ۳۰ واحد پاس بکنی وگرنه نمیشه'
    edited = 'سلام، خوب هستی؟ وقتت بخیر باشه. من درباره دانشگاه ایتالیا بگم. باید ۳۰ واحد پاس بکنی، وگرنه نمی‌شه.'
    assert polish_is_safe(original, edited)
    assert not polish_is_safe(original, edited.replace('۳۰', '۴۰'))
    assert not polish_is_safe(original, edited.replace('نمی‌شه', 'می‌شه'))
    assert not polish_is_safe(original, 'اطلاعات جدید دربارهٔ شرایط بورسیه در ایتالیا.')
    assert not polish_is_safe(original, edited + ' بورسیه هم تضمین شده است.')

    sent = {}
    async def fake_request(client, method, url, **kwargs):
        sent['url'] = url
        sent['body'] = kwargs['json']
        return {'choices': [{'message': {'content': edited}, 'finish_reason': 'stop'}]}
    monkeypatch.setattr('pybackend.providers.request_json', fake_request)
    config = Config().model_dump()
    config.update(chatGptApiKey='test-key', chatGptBaseUrl='https://router.wizdin.xyz/v1')
    assert run(polish_transcript(config, original)) == edited
    assert sent['body']['model'] == 'cx/gpt-6-luna(low)'
    assert sent['url'] == 'https://router.wizdin.xyz/v1/chat/completions'


def test_cleanup_falls_back_to_raw_text(monkeypatch):
    original = 'برای تمدید اقامت باید ۱ درس پاس کنی، نه ۲ درس.'
    config = Config().model_dump()
    config['chatGptApiKey'] = 'test-key'
    request = AsyncMock(return_value={'choices': [{'message': {'content': 'برای تمدید اقامت باید ۲ درس پاس کنی.'}}]})
    monkeypatch.setattr('pybackend.providers.request_json', request)
    assert run(polish_transcript(config, original)) == original
    config['polishTranscript'] = False
    assert run(polish_transcript(config, original)) == original
    assert request.await_count == 1

    config['polishTranscript'] = True
    request.side_effect = RuntimeError('provider unavailable')
    assert run(polish_transcript(config, original)) == original
