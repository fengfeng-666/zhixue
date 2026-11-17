"""Per-user model settings and encrypted API credentials."""
import os
from pathlib import Path
from urllib.parse import urlparse

from cryptography.fernet import Fernet, InvalidToken
from .db import connection


class KeyDecryptionError(Exception):
    """A saved personal API key cannot be decrypted with the active key."""


KEY_ERROR_MESSAGE = '已保存的个人 API Key 无法解密。请恢复原加密密钥，或在模型设置中重新输入或移除个人 API Key。'


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


def decrypt_api_key(encrypted):
    try:
        return cipher().decrypt(encrypted.encode()).decode()
    except (InvalidToken, UnicodeDecodeError) as exc:
        raise KeyDecryptionError(KEY_ERROR_MESSAGE) from exc


def load(user_id, *, allow_invalid_key=False):
    with connection() as conn:
        row = conn.execute('SELECT base_url, chat_model, vision_model, embedding_model, api_key_encrypted FROM model_settings WHERE user_id=%s', (user_id,)).fetchone()
    if row:
        result = dict(row)
        encrypted = result.pop('api_key_encrypted')
        result['key_error'] = False
        try:
            result['api_key'] = decrypt_api_key(encrypted) if encrypted else (os.getenv('OPENAI_API_KEY') or '')
        except KeyDecryptionError:
            if not allow_invalid_key:
                raise
            result['api_key'] = ''
            result['key_error'] = True
        result['has_personal_key'] = bool(encrypted)
        return result
    return {**defaults(), 'api_key': os.getenv('OPENAI_API_KEY') or '', 'has_personal_key': False, 'key_error': False}


def valid_base_url(value):
    parsed = urlparse(value)
    return parsed.scheme in ('http', 'https') and bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
