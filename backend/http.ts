export class AppError extends Error {
  constructor(
    message: string,
    public status = 500,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
export async function boundedBody(response: Response, limit = 2 * 1024 * 1024): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new AppError('Response exceeds the size limit.', 413);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new AppError('Response exceeds the size limit.', 413);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
  timeout = 45000,
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      `Provider returned HTTP ${response.status}.`,
      response.status,
      Math.min(15, Number(response.headers.get('retry-after')) || 0),
    );
  }
  try {
    return JSON.parse((await boundedBody(response)).toString()) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Provider returned invalid JSON.', 502);
  }
}
export const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const end = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', end);
      resolve();
    };
    const timer = setTimeout(end, ms);
    signal?.addEventListener('abort', end, { once: true });
  });
export async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        ![429, 502, 503, 504].includes(error.status) ||
        attempt >= retries
      )
        throw error;
      await delay(Math.max(error.retryAfter * 1000, 700 * 2 ** attempt));
    }
  }
}
