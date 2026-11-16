import hashlib
import hmac
import os
import re
import secrets
from io import BytesIO
from pathlib import Path


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 310000).hex()
    return salt + ':' + digest


def verify_password(password, stored):
    try:
        return hmac.compare_digest(password_hash(password, stored.split(':')[0]), stored)
    except (ValueError, IndexError):
        return False


def chunks(text, size=700, overlap=100):
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    if not text:
        return []
    if size <= 0 or overlap < 0 or overlap >= size:
        raise ValueError('invalid chunk settings')
    result = []
    for start in range(0, len(text), size - overlap):
        part = text[start:start + size].strip()
        if part:
            result.append(part)
        if start + size >= len(text):
            break
    return result


def keywords(text):
    # Character bigrams allow keyword search to work without a Chinese tokenizer.
    terms = re.findall(r'[a-zA-Z0-9]+|[\u4e00-\u9fff]+', text.lower())
    out = []
    for term in terms:
        if re.fullmatch(r'[\u4e00-\u9fff]+', term) and len(term) > 2:
            out.extend(term[i:i + 2] for i in range(len(term) - 1))
        else:
            out.append(term)
    return list(dict.fromkeys(out))[:30]


def extract_text(name, data):
    suffix = Path(name).suffix.lower()
    if suffix in ('.txt', '.md'):
        return data.decode('utf-8-sig')
    if suffix == '.pdf':
        from pypdf import PdfReader
        return '\n'.join(page.extract_text() or '' for page in PdfReader(BytesIO(data)).pages)
    if suffix == '.docx':
        from docx import Document
        doc = Document(BytesIO(data))
        return '\n'.join([p.text for p in doc.paragraphs] + [' | '.join(c.text for c in r.cells) for t in doc.tables for r in t.rows])
    if suffix == '.pptx':
        from pptx import Presentation
        return '\n'.join(shape.text for slide in Presentation(BytesIO(data)).slides for shape in slide.shapes if shape.has_text_frame)
    raise ValueError('不支持的文件类型')
