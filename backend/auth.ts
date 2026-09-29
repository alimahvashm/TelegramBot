import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function equal(a: string, b: string) {
  const left = createHmac('sha256', 'voice-studio-compare').update(a).digest();
  const right = createHmac('sha256', 'voice-studio-compare').update(b).digest();
  return timingSafeEqual(left, right);
}
export function createAuth(password: string, secret = randomBytes(32).toString('hex')) {
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex');
  const sessions = new Map<string, number>();
  const prune = () => {
    for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
  };
  const issue = () => {
    prune();
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString('hex');
    const expires = Date.now() + 8 * 3600000;
    sessions.set(id, expires);
    return `${id}.${sign(id)}`;
  };
  const parse = (cookie = '') =>
    cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('studio_session='))
      ?.slice('studio_session='.length) || '';
  const valid = (value: string) => {
    const [id, signature] = value.split('.');
    return (
      !!id && !!signature && equal(signature, sign(id)) && (sessions.get(id) || 0) > Date.now()
    );
  };
  const guard: RequestHandler = (req, res, next) => {
    if (!valid(parse(req.headers.cookie))) {
      res.status(401).json({ error: 'Please sign in to the dashboard.' });
      return;
    }
    next();
  };
  return {
    issue,
    guard,
    valid,
    parse,
    verify: (input: string) => equal(input, password),
    revoke: (value: string) => {
      sessions.delete(value.split('.')[0]);
    },
  };
}
