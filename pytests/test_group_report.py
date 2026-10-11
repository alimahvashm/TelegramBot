import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from pybackend import group_report
from pybackend.audio import AudioService
from pybackend.errors import AppError
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def history():
    return [{'messageId': index, 'authorId': '1' if index % 2 else '2', 'sender': 'Ali',
             'timestamp': 1000 * index, 'text': f'message {index}', 'replyToId': index - 1}
            for index in range(1, 206)]


def test_window_counts_and_attribution():
    messages = group_report.report_messages(history())
    assert len(messages) == 200 and messages[0]['messageId'] == 6
    output = group_report.activity_report(messages)
    assert 'ID: 1): 100 پیام' in output
    assert 'ID: 2): 100 پیام' in output
    assert 'ID: 2): 100 پاسخ' in output
    assert 'ID: 1): 99 پاسخ' in output
    messages[-1]['authorId'] = None
    assert 'بدون نویسندهٔ قابل‌انتساب: 1' in group_report.activity_report(messages)
    rendered = group_report.findings_report([{'category': 'advertising', 'reason': 'نیازمند بررسی',
                                              'evidence_ids': ['205']}], messages, '-100123')
    assert 'https://t.me/c/123/205' in rendered
    assert 'نویسنده نامشخص' in rendered
    assert 'message 205' in rendered


@pytest.mark.parametrize('ids', [['205'], ['9999'], []])
def test_model_evidence(monkeypatch, ids):
    model = AsyncMock(return_value={'text': json.dumps({'findings': [
        {'category': 'scam', 'reason': 'بررسی درخواست پول', 'evidence_ids': ids}]})})
    monkeypatch.setattr(group_report, 'generate_text', model)
    async def scenario():
        if ids == ['205']:
            result = await group_report.analyze_report({}, group_report.report_messages(history()))
            assert result[0]['evidence_ids'] == ids
            payload = json.loads(model.call_args.args[2])
            assert len(payload['messages']) == 200
            selected = model.call_args.args[0]
            assert selected['chatGptModel'] == 'cx/gpt-6-luna(low)'
            assert selected['openRouterApiKey'] == ''
            assert set(group_report.CATEGORIES) == {'scam', 'insult', 'advertising', 'spam', 'conflict'}
        else:
            with pytest.raises(AppError):
                await group_report.analyze_report({}, group_report.report_messages(history()))
    asyncio.run(scenario())


@pytest.mark.parametrize('role', ['administrator', 'creator', 'member', 'error', 'anonymous', 'private'])
def test_admin_access_cooldown_and_failure(tmp_path, monkeypatch, role):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService())
        bot.reply = AsyncMock()
        bot.call = AsyncMock(return_value={'status': role})
        if role == 'error':
            bot.call.side_effect = AppError('unavailable')
        analyze = AsyncMock(side_effect=AppError('model unavailable'))
        monkeypatch.setattr('pybackend.telegram.analyze_report', analyze)
        message = {'message_id': 400, 'from': {'id': 7}, 'text': '/report',
                   'chat': {'id': -100123, 'type': 'private' if role == 'private' else 'supergroup'}}
        if role == 'anonymous':
            message['sender_chat'] = message['chat']
        chat = bot.chat(message, store.config)
        chat['history'] = history()
        chat['membersUpdatedAt'] = 10**15
        try:
            await bot.handle('test-token', message, store.config)
            if role in ('administrator', 'creator'):
                analyze.assert_awaited_once()
                assert len(analyze.call_args.args[1]) == 200
                assert 'فقط آمار فعالیت' in bot.reply.call_args.args[2]
                await bot.handle('test-token', message, store.config)
                analyze.assert_awaited_once()
                assert '۶۰ ثانیه' in bot.reply.call_args.args[2]
            else:
                analyze.assert_not_awaited()
        finally:
            await bot.close()
    asyncio.run(scenario())
