"""Configuration compatible with the existing dashboard and persisted JSON."""
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field, field_validator

PROMPTS = json.loads((Path(__file__).resolve().parent.parent / 'shared' / 'prompts.json').read_text())
OLD_PROFILE_SCOPE = 'تو نویسندهٔ کارت شخصیت گفتگویی فارسی هستی. فقط پیام‌های نویسندهٔ هدف را، حداکثر ۵۰۰ پیام اخیر، بررسی کن.'
NEW_PROFILE_SCOPE = 'تو نویسندهٔ کارت شخصیت گفتگویی فارسی هستی. تا ۲۰۰۰ پیام اخیر همان گروه را برای فهم زمینه، واکنش‌ها و مسیر گفتگو بخوان؛ ویژگی‌های فرد هدف را فقط از پیام‌های خود او و تعاملش در این زمینه استنتاج کن.'
SECRETS = ('token', 'chatGptApiKey', 'openRouterApiKey', 'geminiApiKey', 'googleSpeechApiKey')

class Config(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token: str = Field(default='', max_length=512)
    enabled: bool = False
    targetApiUrl: str = 'http://127.0.0.1:8000/voice'
    transcribeMode: str = 'google_asr'
    language: str = 'fa-IR'
    autoReply: bool = True
    polishTranscript: bool = True
    startMessage: str = Field(default='Hello! Send me a voice or video note and I will transcribe it. Add me to groups and use /summary to summarize conversations. Use /language fa-IR or /language en-US to change recognition language.', min_length=1, max_length=3500)
    llmBrain: str = 'server_cloud'
    chatGptApiKey: str = Field(default='', max_length=512)
    chatGptBaseUrl: str = 'https://api.openai.com/v1'
    chatGptModel: str = Field(default='gpt-4o-mini', min_length=1, max_length=150)
    openRouterApiKey: str = Field(default='', max_length=512)
    openRouterModel: str = Field(default='openrouter/free', min_length=1, max_length=150)
    geminiApiKey: str = Field(default='', max_length=512)
    geminiModel: str = 'gemini-2.5-flash'
    googleSpeechApiKey: str = Field(default='', max_length=512)
    summarySystemPrompt: str = Field(default=PROMPTS['summary'], min_length=1, max_length=12000)
    educationSystemPrompt: str = Field(default=PROMPTS['education'], min_length=1, max_length=12000)
    profileSystemPrompt: str = Field(default=PROMPTS['profile'], min_length=1, max_length=12000)

    @field_validator('profileSystemPrompt', mode='before')
    @classmethod
    def upgrade_profile_scope(cls, value: str) -> str:
        return value.replace(OLD_PROFILE_SCOPE, NEW_PROFILE_SCOPE) if isinstance(value, str) else value

    @field_validator(*SECRETS)
    @classmethod
    def trim_key(cls, value: str) -> str:
        return value.strip()

    @field_validator('token')
    @classmethod
    def token_shape(cls, value: str) -> str:
        if value and not re.fullmatch(r'\d+:[\w-]{20,}', value):
            raise ValueError('Invalid Telegram bot token')
        return value

    @field_validator('transcribeMode')
    @classmethod
    def mode(cls, value: str) -> str:
        if value not in ('google_asr', 'fastapi', 'gemini'):
            raise ValueError('Invalid speech recognition engine')
        return value

    @field_validator('language')
    @classmethod
    def language_value(cls, value: str) -> str:
        if value not in ('fa-IR', 'en-US'):
            raise ValueError('Invalid recognition language')
        return value

    @field_validator('llmBrain')
    @classmethod
    def brain(cls, value: str) -> str:
        if value not in ('server_cloud', 'chatgpt'):
            raise ValueError('Invalid AI provider')
        return value

    @field_validator('targetApiUrl', 'chatGptBaseUrl')
    @classmethod
    def http_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.netloc or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError('Use an HTTP(S) URL without credentials, query or fragment')
        return value.rstrip('/')

    @field_validator('geminiModel')
    @classmethod
    def gemini_model(cls, value: str) -> str:
        if not re.fullmatch(r'[\w.-]+', value):
            raise ValueError('Invalid Gemini model')
        return value

def from_environment() -> dict:
    return Config.model_validate({
        'token': os.getenv('TELEGRAM_BOT_TOKEN', ''),
        'enabled': os.getenv('BOT_ENABLED') == 'true',
        'chatGptApiKey': os.getenv('OPENAI_API_KEY', ''),
        'chatGptBaseUrl': os.getenv('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        'chatGptModel': os.getenv('OPENAI_MODEL', 'gpt-4o-mini'),
        'llmBrain': os.getenv('LLM_BRAIN', 'server_cloud'),
        'openRouterApiKey': os.getenv('OPENROUTER_API_KEY', ''),
        'geminiApiKey': os.getenv('GEMINI_API_KEY', ''),
        'googleSpeechApiKey': os.getenv('GOOGLE_SPEECH_API_KEY', ''),
        'targetApiUrl': os.getenv('FASTAPI_URL', 'http://127.0.0.1:8000/voice'),
    }).model_dump()

def validate_config(value: dict) -> dict:
    return Config.model_validate(value).model_dump()

def merge_config(current: dict, patch: dict) -> dict:
    if not isinstance(patch, dict):
        raise ValueError('Settings must be an object.')
    unknown = set(patch) - set(Config.model_fields) - {'clearSecrets'}
    if unknown:
        raise ValueError('Unknown setting: ' + ', '.join(sorted(unknown)))
    cleared = patch.get('clearSecrets', [])
    if not isinstance(cleared, list) or any(key not in SECRETS for key in cleared):
        raise ValueError('Invalid secret removal request.')
    values = {key: value for key, value in patch.items() if key != 'clearSecrets'}
    for key in SECRETS:
        if values.get(key) == '':
            values.pop(key)
        if key in cleared:
            values[key] = ''
    return validate_config({**current, **values})

def public_config(config: dict) -> dict:
    return {**config, **{key: '••••••••' if config[key] else '' for key in SECRETS},
            'credentials': {key: bool(config[key]) for key in SECRETS}}

def summary_count(value: str | None) -> int:
    if not value:
        return 50
    if not value.isdecimal():
        raise ValueError('Use /summary or /summary 100 (1–100 messages).')
    return max(1, min(100, int(value)))
