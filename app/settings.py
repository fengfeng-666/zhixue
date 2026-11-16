"""Per-user model settings and encrypted API credentials."""
import os
from pathlib import Path
from urllib.parse import urlparse

from cryptography.fernet import Fernet, InvalidToken
from .db import connection


def defaults():
    return {'base_url': os.getenv('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
            'chat_model': os.getenv('CHAT_MODEL', 'gpt-4o-mini'),
            'vision_model': os.getenv('VISION_MODEL', 'gpt-4o-mini'),
            'embedding_model': os.getenv('EMBEDDING_MODEL', 'text-embedding-3-small')}


def cipher():
    configured = os.getenv('ZHIXUE_ENCRYPTION_KEY')
    if configured:
        return Fernet(configured.encode())
    path = Path(os.getenv('ZHIXUE_DATA_DIR', './data')) / 'model-key'
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'wb') as keyfile:
            keyfile.write(Fernet.generate_key())
    return Fernet(path.read_bytes().strip())


def load(user_id):
    with connection() as conn:
        row = conn.execute('SELECT base_url, chat_model, vision_model, embedding_model, api_key_encrypted FROM model_settings WHERE user_id=%s', (user_id,)).fetchone()
    if row:
        result = dict(row)
        encrypted = result.pop('api_key_encrypted')
        try:
            result['api_key'] = cipher().decrypt(encrypted.encode()).decode() if encrypted else (os.getenv('OPENAI_API_KEY') or '')
        except InvalidToken as exc:
            raise RuntimeError('无法解密模型密钥，请检查服务端加密密钥') from exc
        result['has_personal_key'] = bool(encrypted)
        return result
    return {**defaults(), 'api_key': os.getenv('OPENAI_API_KEY') or '', 'has_personal_key': False}


def valid_base_url(value):
    parsed = urlparse(value)
    return parsed.scheme in ('http', 'https') and bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
