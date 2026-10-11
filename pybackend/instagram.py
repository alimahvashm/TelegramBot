"""Bounded downloads of public Instagram videos."""
import asyncio
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from .errors import AppError

MAX_VIDEO_BYTES = 49_000_000
DOWNLOAD_TIMEOUT = 90
MAX_LINKS = 3
UNAVAILABLE = 'دریافت ویدیو ممکن نشد؛ لینک باید عمومی و دارای ویدیو باشد. اینستاگرام ممکن است دانلود را محدود کند؛ حداکثر حجم قابل ارسال ۴۹ مگابایت است.'


def instagram_links(message: dict) -> list[str]:
    candidates = []
    for field in ('text', 'caption'):
        candidates.extend(re.findall(
            r'(?<![\w@/])(?:https?://)?(?:www\.)?instagram\.com/[^\s<>"\u200c]+',
            message.get(field) or '', re.I))
    for field in ('entities', 'caption_entities'):
        candidates.extend(entity.get('url', '') for entity in message.get(field, [])
                          if entity.get('type') == 'text_link')
    links = []
    for candidate in candidates:
        try:
            parsed = urlsplit(candidate if '://' in candidate else 'https://' + candidate)
            if parsed.scheme not in ('http', 'https') or parsed.netloc.lower() not in ('instagram.com', 'www.instagram.com'):
                continue
            path = parsed.path.rstrip('.,!?،؛)]}')
            if not re.fullmatch(r'/(?:p|reel|reels|tv)/[A-Za-z0-9_-]+/?', path):
                continue
            link = 'https://www.instagram.com' + path.rstrip('/') + '/'
            if link not in links:
                links.append(link)
        except ValueError:
            continue
    return links


@asynccontextmanager
async def download_video(url: str):
    if instagram_links({'text': url}) != [url]:
        raise AppError('Invalid Instagram video link.', 422)
    with TemporaryDirectory(prefix='instagram-') as directory:
        folder = Path(directory)
        process = await asyncio.create_subprocess_exec(
            sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-plugin-dirs',
            '--no-cache-dir', '--no-progress', '--quiet', '--no-warnings',
            '--use-extractors', 'Instagram', '--playlist-items', '1',
            '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1',
            '--max-filesize', str(MAX_VIDEO_BYTES),
            '--format', 'best[ext=mp4][protocol=https]/best[ext=mp4][protocol=http]',
            '--output', str(folder / 'video.%(ext)s'), '--', url,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            async with asyncio.timeout(DOWNLOAD_TIMEOUT):
                while process.returncode is None:
                    if sum(path.stat().st_size for path in folder.iterdir() if path.is_file()) > MAX_VIDEO_BYTES:
                        raise AppError('حجم این ویدیو بیشتر از ۴۹ مگابایت است.', 413)
                    await asyncio.sleep(0.1)
                await process.wait()
            video = folder / 'video.mp4'
            if process.returncode or not video.is_file() or not 0 < video.stat().st_size <= MAX_VIDEO_BYTES:
                raise AppError(UNAVAILABLE, 422)
            yield video
        except TimeoutError:
            raise AppError('دریافت ویدیو از اینستاگرام بیش از حد طول کشید؛ دوباره تلاش کن.', 504)
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
