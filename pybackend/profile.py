"""Per-group message archive and evidence-based Persian conversation cards."""
import json
import os
import sqlite3
from pathlib import Path

import httpx

from .errors import AppError, request_json

FIELDS = ('chat_personality', 'social_orientation', 'attractive_trait',
          'annoying_trait', 'superpower', 'nickname')
LABELS = ('شخصیت گفتگویی', 'گرایش اجتماعی', 'ویژگی جذاب', 'ویژگی روی مخ',
          'قدرت ویژهٔ چتی', 'لقب اختصاصی')


class ProfileArchive:
    def __init__(self, directory: str | Path):
        self.path = Path(directory) / 'profile_messages.sqlite3'
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS messages (chat_id TEXT NOT NULL, user_id TEXT NOT NULL, message_id INTEGER NOT NULL, timestamp INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(chat_id,user_id,message_id))')
            db.execute('CREATE INDEX IF NOT EXISTS profile_recent ON messages(chat_id,user_id,message_id DESC)')

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        os.chmod(self.path, 0o600)
        return db

    def remember(self, chat_id: str, user_id: str, message_id: int, timestamp: int, text: str):
        text = text.strip()[:1200]
        if not text:
            return
        with self._connect() as db:
            db.execute('INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?)', (chat_id, user_id, message_id, timestamp, text))
            db.execute('DELETE FROM messages WHERE chat_id=? AND user_id=? AND message_id NOT IN (SELECT message_id FROM messages WHERE chat_id=? AND user_id=? ORDER BY message_id DESC LIMIT 500)', (chat_id, user_id, chat_id, user_id))

    def forget(self, chat_id: str, user_id: str):
        with self._connect() as db:
            db.execute('DELETE FROM messages WHERE chat_id=? AND user_id=?', (chat_id, user_id))

    def recent(self, chat_id: str, user_id: str) -> list[dict]:
        with self._connect() as db:
            rows = db.execute('SELECT message_id,timestamp,text FROM messages WHERE chat_id=? AND user_id=? ORDER BY message_id DESC LIMIT 500', (chat_id, user_id)).fetchall()
        return [{'id': str(mid), 'author_id': user_id, 'timestamp': timestamp, 'text': text}
                for mid, timestamp, text in reversed(rows)]


def _validated_card(result: dict, evidence: set[str]) -> dict:
    if not isinstance(result, dict) or result.get('status') not in ('ok', 'insufficient_evidence'):
        raise AppError('The profile model returned an invalid card.', 502)
    cleaned = {}
    for field in FIELDS:
        value = result.get(field)
        if value is None:
            cleaned[field] = None
            continue
        if not isinstance(value, dict) or any(not isinstance(value.get(key), str) or not value[key].strip() for key in ('text', 'reason', 'basis')):
            cleaned[field] = None
            continue
        ids = value.get('evidence_ids')
        if not isinstance(ids, list) or not ids or any(str(mid) not in evidence for mid in ids):
            cleaned[field] = None
            continue
        if field in ('chat_personality', 'attractive_trait', 'annoying_trait', 'superpower', 'nickname') and len({str(mid) for mid in ids}) < 2:
            cleaned[field] = None
            continue
        allowed = ('creative_reframing',) if field in ('superpower', 'nickname') else ('self_report', 'tentative_interpretation') if field == 'social_orientation' else ('tentative_interpretation',) if field == 'chat_personality' else ('observed_pattern',)
        if value['basis'] not in allowed:
            cleaned[field] = None
            continue
        cleaned[field] = {'text': value['text'].strip()[:300], 'reason': value['reason'].strip()[:500], 'evidence_ids': [str(mid) for mid in ids]}
    return cleaned


async def generate_profile(config: dict, user_id: str, messages: list[dict]) -> dict:
    if not config.get('chatGptApiKey'):
        raise AppError('Profile model API key is not configured.', 503)
    if not messages:
        raise AppError('No group messages are available yet.', 422)
    base_url = config['chatGptBaseUrl'].rstrip('/')
    model = 'gpt-6-sol' if base_url == 'https://api.openai.com/v1' else 'cx/gpt-6-sol(medium)'
    payload = {'target_user_id': user_id, 'messages_order': 'oldest_first',
               'messages': [{**item, 'text': item['text'][:600]} for item in messages[-500:]]}
    async with httpx.AsyncClient() as client:
        result = await request_json(client, 'POST', base_url + '/chat/completions', timeout=120,
            headers={'Authorization': 'Bearer ' + config['chatGptApiKey']}, json={
                'model': model, 'reasoning_effort': 'medium', 'max_completion_tokens': 5500,
                'messages': [{'role': 'system', 'content': config['profileSystemPrompt']},
                             {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)}]})
    choice = (result.get('choices') or [{}])[0]
    raw = choice.get('message', {}).get('content')
    if choice.get('finish_reason') == 'length' or not isinstance(raw, str):
        raise AppError('The profile model did not finish its card.', 502)
    try:
        card = json.loads(raw.strip())
    except (ValueError, TypeError) as exc:
        raise AppError('The profile model returned invalid JSON.', 502) from exc
    return _validated_card(card, {item['id'] for item in messages})


def format_profile(card: dict, name: str, message_count: int) -> str:
    lines = [f'🎭 کارت گفتگویی {name}', f'بر اساس {message_count} پیام ثبت‌شده در همین گروه']
    for field, label in zip(FIELDS, LABELS):
        value = card[field]
        lines.append(f'\n{label}: {value["text"] if value else "شواهد کافی نیست"}')
    return '\n'.join(lines)
