"""Persian B Nazanin PDF rendering through the WeasyPrint CLI."""
import asyncio
import base64
import html
import os
import re
from pathlib import Path
from .errors import AppError

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / 'assets' / 'fonts'

def education_html(notes: str, images: list[bytes] | None = None) -> str:
    lines = notes.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    blocks, paragraph = [], []
    title_used = False
    def flush():
        if paragraph:
            blocks.append('<p>' + '<br>'.join(html.escape(part, quote=True) for part in paragraph) + '</p>')
            paragraph.clear()
    for index, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            flush()
            continue
        if re.fullmatch(r'[─━]{3,}', line):
            flush(); blocks.append('<hr>'); continue
        previous_blank = index == 0 or not lines[index - 1].strip()
        next_blank = index == len(lines) - 1 or not lines[index + 1].strip()
        heading = (previous_blank and (next_blank or (not title_used and index == 0)) and
                   len(line) <= 90 and not re.search(r'[.!?؟؛،]$', line) and
                   not re.match(r'[\d۰-۹]+[.)\-\s]', line) and not re.match(r'[•\-–]', line))
        if heading:
            flush()
            tag = 'h2' if title_used else 'h1'
            blocks.append(f'<{tag}>{html.escape(line)}</{tag}>')
            title_used = True
        elif re.match(r'[•\-–]\s*', line):
            flush(); blocks.append(f'<p class="bullet">{html.escape(line)}</p>')
        else:
            paragraph.append(line)
    flush()
    if images:
        blocks.append('<h2 class="photo-heading">تصاویر پیوست</h2>')
        for index, photo in enumerate(images, 1):
            encoded = base64.b64encode(photo).decode('ascii')
            blocks.append(f'<figure><img src="data:image/jpeg;base64,{encoded}" alt="تصویر {index}">'
                          f'<figcaption>تصویر {index}</figcaption></figure>')
    return f'''<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>جزوه آموزشی</title>
<style>
@font-face {{ font-family: 'B Nazanin'; src: url('{(FONT_DIR / 'BNazanin.ttf').as_uri()}') format('truetype'); font-weight: 400; }}
@font-face {{ font-family: 'B Nazanin'; src: url('{(FONT_DIR / 'BNaznnBd.ttf').as_uri()}') format('truetype'); font-weight: 700; }}
@page {{ size: A4; margin: 20mm 20mm 22mm; @bottom-center {{ content: counter(page); color: #64748b; font: 10pt 'B Nazanin'; }} }}
body {{ direction: rtl; text-align: right; font: 14pt/1.75 'B Nazanin', serif; color: #202a3a; }}
h1, h2 {{ font-family: 'B Nazanin', serif; font-weight: 700; line-height: 1.5; break-after: avoid; }}
h1 {{ font-size: 22pt; color: #17375e; margin: 0 0 12mm; padding-bottom: 4mm; border-bottom: 1px solid #cbd5e1; }}
h2 {{ font-size: 17pt; color: #24456f; margin: 8mm 0 3mm; }}
p {{ margin: 0 0 4mm; overflow-wrap: anywhere; orphans: 2; widows: 2; }}
p.bullet {{ padding-right: 5mm; margin-bottom: 2mm; }}
hr {{ border: 0; border-top: 1px solid #cbd5e1; margin: 8mm 0; }}
figure {{ margin: 5mm 0 10mm; break-inside: avoid; text-align: center; }}
figure img {{ max-width: 100%; max-height: 215mm; object-fit: contain; }}
figcaption {{ font-size: 11pt; color: #64748b; margin-top: 2mm; }}
.photo-heading {{ break-before: page; }}
</style></head><body>{''.join(blocks)}</body></html>'''

async def render_education_pdf(notes: str, images: list[bytes] | None = None) -> bytes:
    if not notes.strip():
        raise AppError('No education notes are available for the PDF.', 422)
    try:
        process = await asyncio.create_subprocess_exec(os.getenv('WEASYPRINT_PATH', 'weasyprint'), '-', '-',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        output, _ = await asyncio.wait_for(process.communicate(education_html(notes, images).encode()), 180)
    except (OSError, asyncio.TimeoutError):
        if 'process' in locals() and process.returncode is None:
            process.kill(); await process.wait()
        raise AppError('The PDF renderer is unavailable or timed out.', 503)
    if len(output) > 45 * 1024 * 1024:
        raise AppError('The PDF exceeds the document size limit.', 413)
    if process.returncode or not output.startswith(b'%PDF-'):
        raise AppError('PDF rendering failed.', 503)
    return output
