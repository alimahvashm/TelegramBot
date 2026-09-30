import asyncio
import httpx

class AppError(Exception):
    def __init__(self, message: str, status: int = 500, retry_after: float = 0):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after

async def response_bytes(response: httpx.Response, limit: int = 2 * 1024 * 1024) -> bytes:
    if int(response.headers.get('content-length', '0') or 0) > limit:
        raise AppError('Response exceeds the size limit.', 413)
    data = response.content
    if len(data) > limit:
        raise AppError('Response exceeds the size limit.', 413)
    return data

async def request_json(client: httpx.AsyncClient, method: str, url: str, *, timeout: float = 45,
                       headers: dict | None = None, json: dict | None = None, data=None, files=None):
    response = await client.request(method, url, headers=headers, json=json, data=data, files=files,
                                    timeout=timeout, follow_redirects=False)
    if response.status_code >= 400:
        raise AppError(f'Provider returned HTTP {response.status_code}.', response.status_code,
                       min(15, float(response.headers.get('retry-after', '0') or 0)))
    raw = await response_bytes(response)
    try:
        import json as jsonlib
        return jsonlib.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise AppError('Provider returned invalid JSON.', 502)

async def with_retry(fn, retries: int = 1):
    for attempt in range(retries + 1):
        try:
            return await fn()
        except AppError as exc:
            if exc.status not in (429, 502, 503, 504) or attempt == retries:
                raise
            await asyncio.sleep(max(exc.retry_after, 0.7 * (2 ** attempt)))
