"""FastAPI dashboard and static frontend for the Python bot."""
import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request, UploadFile, File, Form
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from .audio import AudioService, MAX_BYTES
from .auth import Auth
from .config import merge_config, public_config
from .errors import AppError
from .providers import summarize, verify_openai
from .store import Store
from .telegram import TelegramBot

ROOT = Path(__file__).resolve().parent.parent

def load_local_env():
    path = ROOT / '.env'
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line.startswith('export '):
            line = line[7:]
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('\"', "'"):
            value = value[1:-1]
        os.environ.setdefault(key, value)

load_local_env()

class RateLimiter:
    def __init__(self):
        self.hits = {}

    def check(self, key, limit, window, message):
        now = time.monotonic()
        values = [stamp for stamp in self.hits.get(key, []) if stamp > now - window]
        if len(values) >= limit:
            raise AppError(message, 429)
        values.append(now)
        self.hits[key] = values
        if len(self.hits) > 10000:
            self.hits = {name: stamps for name, stamps in self.hits.items() if stamps[-1] > now - window}


def create_app(store: Store | None = None, bot: TelegramBot | None = None, audio: AudioService | None = None,
               password: str | None = None, start_bot: bool = True) -> FastAPI:
    password = password if password is not None else os.getenv('ADMIN_PASSWORD', '')
    if len(password) < 16:
        raise RuntimeError('Set ADMIN_PASSWORD in .env to at least 16 characters before starting.')
    store = store or Store(os.getenv('DATA_DIR', './data'))
    audio = audio or AudioService(lambda msg: store.log('info', msg))
    bot = bot or TelegramBot(store, audio)
    auth = Auth(password)
    limiter = RateLimiter()
    updating = asyncio.Lock()
    summary_workers = 0
    upload_workers = 0

    async def save_periodically():
        while True:
            await asyncio.sleep(15)
            try:
                await store.save_state()
            except Exception:
                store.log('error', 'Failed to persist chat history. Check disk space and permissions.')

    @asynccontextmanager
    async def lifespan(_app):
        await store.init()
        timer = asyncio.create_task(save_periodically())
        if start_bot:
            await bot.reconcile()
        store.log('info', 'Voice Studio Python backend started.')
        try:
            yield
        finally:
            timer.cancel()
            await bot.close()
            await store.save_state()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(AppError)
    async def app_error(_request, exc):
        return JSONResponse({'error': str(exc)}, status_code=exc.status if 400 <= exc.status < 600 else 500)

    @app.exception_handler(ValidationError)
    async def validation_error(_request, exc):
        return JSONResponse({'error': '; '.join('.'.join(map(str, item['loc'])) + ': ' + item['msg'] for item in exc.errors())}, status_code=400)

    @app.exception_handler(ValueError)
    async def value_error(_request, exc):
        return JSONResponse({'error': str(exc)}, status_code=400)

    @app.exception_handler(Exception)
    async def unexpected(_request, _exc):
        store.log('error', 'An unexpected request error occurred.')
        return JSONResponse({'error': 'Request failed. Check server connectivity and provider configuration.'}, status_code=500)

    @app.middleware('http')
    async def security(request: Request, call_next):
        path = request.url.path
        if path.startswith('/api'):
            if request.method not in ('GET', 'HEAD', 'OPTIONS'):
                expected = os.getenv('APP_ORIGIN') or f'{request.url.scheme}://{request.headers.get("host", "")}'
                origin = request.headers.get('origin')
                if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and origin != expected):
                    return JSONResponse({'error': 'Cross-origin requests are not allowed.'}, status_code=403)
            address = request.client.host if request.client else 'unknown'
            try:
                if path == '/api/auth/login':
                    limiter.check(('login', address), 15, 900, 'Too many sign-in attempts. Try again in 15 minutes.')
                else:
                    if not auth.valid(request.cookies.get('studio_session')):
                        return JSONResponse({'error': 'Sign in to access the dashboard.'}, status_code=401)
                    limiter.check(('api', address), 180, 60, 'Too many requests. Try again shortly.')
                    if path in ('/api/bot/restart', '/api/bot/verify-chatgpt', '/api/bot/test-summary', '/api/transcode'):
                        limiter.check(('expensive', address), 10, 60, 'Please wait before starting another provider request.')
            except AppError as exc:
                return JSONResponse({'error': str(exc)}, status_code=exc.status)
        response = await call_next(request)
        if path.startswith('/api'):
            response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    def snapshot():
        config = store.config
        return {'config': public_config(config), 'status': bot.status,
                'readiness': {'cloud': bool(config['openRouterApiKey']), 'openai': bool(config['chatGptApiKey']),
                              'asr': config['transcribeMode'] != 'gemini' or bool(config['geminiApiKey'])}}

    async def body(request):
        data = await request.body()
        if len(data) > 96 * 1024:
            raise AppError('Request body is too large.', 413)
        try:
            value = json.loads(data) if data else {}
        except json.JSONDecodeError:
            raise AppError('Invalid JSON request.', 400)
        if not isinstance(value, dict):
            raise AppError('Request body must be an object.', 400)
        return value

    @app.get('/healthz')
    async def health():
        return {'ok': True}

    @app.post('/api/auth/login')
    async def login(request: Request):
        value = (await body(request)).get('password')
        if not isinstance(value, str) or len(value) > 512:
            raise AppError('Enter a valid dashboard password.', 400)
        if not auth.verify(value):
            raise AppError('Incorrect dashboard password.', 401)
        response = JSONResponse({'ok': True})
        response.set_cookie('studio_session', auth.issue(), max_age=8 * 3600, httponly=True,
                            samesite='strict', secure=os.getenv('COOKIE_SECURE') == 'true', path='/')
        return response

    @app.get('/api/auth/session')
    async def session():
        return {'ok': True}

    @app.post('/api/auth/logout')
    async def logout(request: Request):
        auth.revoke(request.cookies.get('studio_session'))
        response = JSONResponse({'ok': True})
        response.delete_cookie('studio_session', path='/')
        return response

    @app.get('/api/bot/config')
    async def get_config():
        return snapshot()

    @app.post('/api/bot/config')
    async def put_config(request: Request):
        if updating.locked():
            raise AppError('Another settings update is in progress.', 409)
        async with updating:
            previous = store.config
            config = merge_config(previous, await body(request))
            if config['enabled'] and not config['token']:
                raise AppError('Add a bot token before enabling polling.', 400)
            await store.save_config(config)
            if previous['token'] != config['token'] or previous['enabled'] != config['enabled']:
                await bot.reconcile()
            store.log('info', 'Bot settings saved.')
            return snapshot()

    @app.post('/api/bot/restart')
    async def restart():
        await bot.reconcile()
        return snapshot()

    @app.get('/api/bot/audience')
    async def audience():
        chats = list(store.state['chats'].values())
        metrics = store.state['metrics']
        return {'chats': sorted(({key: value for key, value in chat.items() if key != 'history'} for chat in chats),
                                key=lambda chat: chat.get('lastActive', 0), reverse=True),
                'metrics': {**metrics, 'groups': sum(chat['type'] != 'private' for chat in chats),
                            'privateUsers': sum(chat['type'] == 'private' for chat in chats),
                            'uniqueUsers': len(store.state['users']),
                            'successRate': round(metrics['succeeded'] / metrics['processed'] * 100) if metrics['processed'] else None}}

    @app.patch('/api/bot/audience/{chat_id}')
    async def patch_audience(chat_id: str, request: Request):
        if not re.fullmatch(r'-?\d+', chat_id):
            raise AppError('Invalid chat ID.', 400)
        patch = await body(request)
        if set(patch) - {'enabled', 'language', 'clearHistory'} or any(not isinstance(patch[k], bool) for k in ('enabled', 'clearHistory') if k in patch) or ('language' in patch and patch['language'] not in ('fa-IR', 'en-US')):
            raise AppError('Invalid audience settings.', 400)
        chat = store.state['chats'].get(chat_id)
        if not chat:
            raise AppError('Chat not found.', 404)
        if 'enabled' in patch: chat['enabled'] = patch['enabled']
        if 'language' in patch: chat['language'] = patch['language']
        if patch.get('clearHistory'): chat['history'] = []
        await store.save_state()
        return {'ok': True}

    @app.post('/api/bot/verify-chatgpt')
    async def verify(request: Request):
        value = await body(request)
        if set(value) - {'apiKey', 'baseUrl'}:
            raise AppError('Invalid provider settings.', 400)
        config = merge_config(store.config, {'chatGptBaseUrl': value['baseUrl']} if value.get('baseUrl') else {})
        return await verify_openai(value.get('apiKey') or config['chatGptApiKey'], config['chatGptBaseUrl'])

    @app.post('/api/bot/test-summary')
    async def test_summary(request: Request):
        nonlocal summary_workers
        if summary_workers >= 2:
            raise AppError('Summary workers are busy. Try again shortly.', 429)
        value = await body(request)
        if set(value) - {'config'}:
            raise AppError('Invalid summary settings.', 400)
        config = merge_config(store.config, value['config']) if value.get('config') is not None else store.config
        summary_workers += 1
        try:
            now = int(time.time() * 1000)
            messages = [
                {'messageId': 1, 'timestamp': now - 120000, 'sender': 'سارا', 'text': 'جلسه بررسی پروژه فردا ساعت ده برگزار می‌شود. لطفاً گزارش تست را آماده کنید.'},
                {'messageId': 2, 'timestamp': now - 60000, 'sender': 'علی', 'text': 'من گزارش تست را تا امشب ارسال می‌کنم. مشکل ورود کاربران هم رفع شد.'},
                {'messageId': 3, 'timestamp': now, 'sender': 'مریم', 'text': 'طراحی جدید را در فایل dashboard.pdf فرستادم. فردا درباره آن تصمیم می‌گیریم.'}]
            return await summarize(config, messages, lambda msg: store.log('warn', msg))
        finally:
            summary_workers -= 1

    @app.post('/api/transcode')
    async def transcode(audio_file: UploadFile = File(alias='audio'), language: str | None = Form(default=None)):
        nonlocal upload_workers
        if upload_workers >= 2:
            raise AppError('Audio upload workers are busy. Try again shortly.', 429)
        if language is not None and language not in ('fa-IR', 'en-US'):
            raise AppError('Invalid recognition language.', 400)
        upload_workers += 1
        store.state['metrics']['processed'] += 1
        try:
            data = await audio_file.read(MAX_BYTES + 1)
            result = await audio.process(data, store.config, language or store.config['language'], True)
            store.state['metrics']['succeeded'] += 1
            return result
        except Exception:
            store.state['metrics']['failed'] += 1
            raise
        finally:
            upload_workers -= 1
            await store.save_state()

    @app.get('/api/events')
    async def events(request: Request):
        if len(store.subscribers) >= 30:
            raise AppError('Too many live console connections.', 429)
        queue = asyncio.Queue(maxsize=100)
        store.subscribers.add(queue)
        async def stream():
            try:
                yield 'event: snapshot\ndata: ' + json.dumps(list(store.logs), ensure_ascii=False) + '\n\n'
                while not await request.is_disconnected():
                    if not auth.valid(request.cookies.get('studio_session')):
                        break
                    try:
                        item = await asyncio.wait_for(queue.get(), 20)
                        yield 'event: log\ndata: ' + json.dumps(item, ensure_ascii=False) + '\n\n'
                    except asyncio.TimeoutError:
                        yield ': heartbeat\n\n'
            finally:
                store.subscribers.discard(queue)
        return StreamingResponse(stream(), media_type='text/event-stream', headers={'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store'})

    @app.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    async def missing_api(path: str):
        raise AppError('API endpoint not found.', 404)

    public = ROOT / 'dist' / 'public'
    if public.exists():
        app.mount('/assets', StaticFiles(directory=public / 'assets'), name='assets')

    @app.get('/{path:path}')
    async def spa(path: str):
        if path.startswith('api/'):
            raise AppError('API endpoint not found.', 404)
        candidate = (public / path).resolve()
        if candidate.is_file() and candidate.is_relative_to(public.resolve()):
            return FileResponse(candidate)
        index = public / 'index.html'
        if index.is_file():
            return FileResponse(index)
        raise AppError('Frontend has not been built.', 503)

    return app

app = create_app()
