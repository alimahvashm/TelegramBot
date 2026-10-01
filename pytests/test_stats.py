import asyncio
import time
from unittest.mock import AsyncMock

from pybackend.audio import AudioService
from pybackend.store import Store
from pybackend.telegram import TelegramBot


def test_stats_migrates_known_counts_and_tracks_new_messages(tmp_path):
    async def scenario():
        store = Store(tmp_path)
        await store.init()
        bot = TelegramBot(store, AudioService())
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        def message(chat_id, kind, mid, **fields):
            return {'chat': {'id': chat_id, 'type': kind}, 'message_id': mid,
                    'date': int(time.time()), 'from': {'id': 10, 'first_name': 'A'}, **fields}
        group = bot.chat(message(-10, 'supergroup', 1, text='old'), store.config)
        group['audioCount'] = 4
        bot.chat(message(20, 'private', 1, text='old'), store.config)
        store.state['metrics']['pdfsGenerated'] = 3
        for key in ('groupsSeen', 'privateChatsSeen', 'voiceMessagesSeen', 'stickersSeen', 'stickerTrackingStartedAt'):
            store.state['metrics'].pop(key)
        await store.save_state()
        await bot.close()

        restored = Store(tmp_path)
        await restored.init()
        metrics = restored.state['metrics']
        assert (metrics['groupsSeen'], metrics['privateChatsSeen'], metrics['voiceMessagesSeen'],
                metrics['stickersSeen'], metrics['pdfsGenerated']) == (1, 1, 4, 0, 3)
        bot = TelegramBot(restored, AudioService())
        bot.status['bot'] = {'id': 999, 'username': 'testbot'}
        sent = []
        async def fake_call(token, method, data=None, timeout=None):
            if method == 'sendMessage':
                sent.append(data['text'])
                return {'message_id': 100}
            if method == 'getChatMemberCount': return 3
            return True
        bot.call = fake_call
        bot.transcribe_media = AsyncMock(return_value='transcript')
        restored.config['autoReply'] = False
        sticker = message(-10, 'supergroup', 2, sticker={'file_id': 'sticker-id'})
        await bot.handle('token', sticker, restored.config)
        await bot.handle('token', sticker, restored.config)
        await bot.handle('token', message(20, 'private', 2, voice={'file_id': 'voice-id'}), restored.config)
        await bot.handle('token', message(-10, 'supergroup', 3, text='/stats'), restored.config)
        assert metrics['stickersSeen'] == 1
        assert metrics['voiceMessagesSeen'] == 5
        assert all(part in sent[-1] for part in ('استیکرهای دریافت‌شده: 1', 'پیام‌های صوتی', 'گروه‌ها: 1',
                                                'چت‌های خصوصی: 1', 'پی‌دی‌اف‌های ساخته‌شده: 3'))
        await restored.save_state()
        again = Store(tmp_path)
        await again.init()
        assert again.state['metrics']['stickersSeen'] == 1
        assert again.state['metrics']['voiceMessagesSeen'] == 5
        await bot.close()
    asyncio.run(scenario())
