export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  const data = await response
    .json()
    .catch(() => ({ error: 'Server returned an invalid response.' }));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login')
      window.dispatchEvent(new Event('session-expired'));
    throw new Error(data.error || 'Request failed.');
  }
  return data as T;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
