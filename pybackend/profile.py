"""Group-context input and evidence-based Persian conversation cards."""
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


class LegacyProfileArchive:
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

    def legacy_authors(self, chat_id: str, first_message_id: int) -> dict[int, str]:
        """Identify authors in history entries written before author IDs were stored."""
        with self._connect() as db:
            rows = db.execute('SELECT message_id,user_id FROM messages WHERE chat_id=? AND message_id>=?',
                              (chat_id, first_message_id)).fetchall()
        return {message_id: user_id for message_id, user_id in rows}


def group_profile_messages(history: list[dict], legacy_authors: dict[int, str] | None = None) -> list[dict]:
    authors = legacy_authors or {}
    result = []
    for item in history[-2000:]:
        message_id = item.get('messageId')
        if not isinstance(message_id, int) or not isinstance(item.get('text'), str) or not item['text'].strip():
            continue
        author_id = item.get('authorId') or authors.get(message_id)
        message = {'id': str(message_id), 'author_id': str(author_id) if author_id else None,
                   'timestamp': item.get('timestamp', 0), 'text': item['text'],
                   'sender': item.get('sender', '')}
        if item.get('replyToId'):
            message['reply_to_id'] = str(item['replyToId'])
        result.append(message)
    return result


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
    selected = messages[-2000:]
    if not any(item.get('author_id') == user_id for item in selected):
        raise AppError('No messages from this user are available in recent group history.', 422)
    base_url = config['chatGptBaseUrl'].rstrip('/')
    model = 'gpt-6-sol' if base_url == 'https://api.openai.com/v1' else 'cx/gpt-6-sol(medium)'
    caps = [500 if item.get('author_id') == user_id else 220 for item in selected]
    proposed = sum(min(len(item['text']), cap) for item, cap in zip(selected, caps))
    scale = min(1.0, 300000 / proposed) if proposed else 1.0
    payload = {'target_user_id': user_id, 'messages_order': 'oldest_first',
               'messages': [{**item, 'text': item['text'][:max(80, int(cap * scale))]}
                            for item, cap in zip(selected, caps)]}
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
    return _validated_card(card, {item['id'] for item in selected if item.get('author_id') == user_id})


def format_profile(card: dict, name: str, message_count: int, target_count: int) -> str:
    lines = [f'🎭 کارت گفتگویی {name}',
             f'بر اساس {message_count} پیام اخیر گروه، شامل {target_count} پیام از این کاربر']
    for field, label in zip(FIELDS, LABELS):
        value = card[field]
        lines.append(f'\n{label}: {value["text"] if value else "شواهد کافی نیست"}')
    return '\n'.join(lines)
