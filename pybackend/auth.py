"""Dashboard sessions, scoped to the running server process."""
import hashlib
import hmac
import secrets
import time

class Auth:
    def __init__(self, password: str):
        self.password = password
        self.secret = secrets.token_bytes(32)
        self.sessions: dict[str, float] = {}

    def verify(self, input_password: str) -> bool:
        left = hmac.new(b'voice-studio-compare', input_password.encode(), hashlib.sha256).digest()
        right = hmac.new(b'voice-studio-compare', self.password.encode(), hashlib.sha256).digest()
        return hmac.compare_digest(left, right)

    def issue(self) -> str:
        self.sessions = {key: expires for key, expires in self.sessions.items() if expires > time.time()}
        if len(self.sessions) >= 100:
            self.sessions.pop(next(iter(self.sessions)))
        key = secrets.token_hex(32)
        self.sessions[key] = time.time() + 8 * 3600
        signature = hmac.new(self.secret, key.encode(), hashlib.sha256).hexdigest()
        return key + '.' + signature

    def valid(self, cookie: str | None) -> bool:
        try:
            key, signature = (cookie or '').split('.', 1)
        except ValueError:
            return False
        expected = hmac.new(self.secret, key.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature, expected) and self.sessions.get(key, 0) > time.time()

    def revoke(self, cookie: str | None):
        key = (cookie or '').split('.', 1)[0]
        self.sessions.pop(key, None)
