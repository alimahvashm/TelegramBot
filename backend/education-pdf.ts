import { spawn } from 'node:child_process';
import { AppError } from './http.js';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

const isHeading = (line: string, previousBlank: boolean, nextBlank: boolean) =>
  previousBlank &&
  nextBlank &&
  line.length <= 90 &&
  !/[.!?؟؛،]$/.test(line) &&
  !/^[\d۰-۹]+[.)\-\s]/.test(line) &&
  !/^[•\-–]/.test(line);

export function educationHtml(notes: string) {
  const lines = notes.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let titleUsed = false;
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(escapeHtml).join('<br>')}</p>`);
    paragraph = [];
  };
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^[─━]{3,}$/.test(line)) {
      flush();
      blocks.push('<hr>');
      continue;
    }
    const previousBlank = index === 0 || !lines[index - 1].trim();
    const nextBlank = index === lines.length - 1 || !lines[index + 1].trim();
    if (isHeading(line, previousBlank, nextBlank || (!titleUsed && index === 0))) {
      flush();
      blocks.push(`<${titleUsed ? 'h2' : 'h1'}>${escapeHtml(line)}</${titleUsed ? 'h2' : 'h1'}>`);
      titleUsed = true;
    } else if (/^[•\-–]\s*/.test(line)) {
      flush();
      blocks.push(`<p class="bullet">${escapeHtml(line)}</p>`);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>جزوه آموزشی</title>
<style>
@font-face { font-family: 'B Nazanin'; src: url('file:///app/assets/fonts/BNazanin.ttf') format('truetype'); font-weight: 400; }
@font-face { font-family: 'B Nazanin'; src: url('file:///app/assets/fonts/BNaznnBd.ttf') format('truetype'); font-weight: 700; }
@page { size: A4; margin: 20mm 20mm 22mm; background: #fff; @bottom-center { content: counter(page); color: #64748b; font: 10pt 'B Nazanin'; } }
body { direction: rtl; text-align: right; font: 14pt/1.75 'B Nazanin', serif; color: #202a3a; background: #fff; }
h1, h2 { font-family: 'B Nazanin', serif; font-weight: 700; line-height: 1.5; break-after: avoid; }
h1 { font-size: 22pt; color: #17375e; margin: 0 0 12mm; padding-bottom: 4mm; border-bottom: 1px solid #cbd5e1; }
h2 { font-size: 17pt; color: #24456f; margin: 8mm 0 3mm; }
p { margin: 0 0 4mm; white-space: normal; overflow-wrap: anywhere; orphans: 2; widows: 2; }
p.bullet { padding-right: 5mm; margin-bottom: 2mm; }
hr { border: 0; border-top: 1px solid #cbd5e1; margin: 8mm 0; }
</style></head><body>${blocks.join('\n')}</body></html>`;
}

export function renderEducationPdf(notes: string): Promise<Buffer> {
  if (!notes.trim()) throw new AppError('No education notes are available for the PDF.', 422);
  const html = educationHtml(notes);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.WEASYPRINT_PATH || 'weasyprint', ['-', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: Error, pdf?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(pdf!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AppError('PDF rendering timed out.', 503));
    }, 180000);
    child.on('error', () => finish(new AppError('The PDF renderer is unavailable.', 503)));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 45 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new AppError('The PDF exceeds the document size limit.', 413));
      } else chunks.push(chunk);
    });
    child.on('close', (code) => {
      const pdf = Buffer.concat(chunks);
      if (code !== 0 || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
        finish(new AppError('PDF rendering failed.', 503));
      else finish(undefined, pdf);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(html);
  });
}
