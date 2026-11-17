import hashlib
import json
import os
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import redis
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from langgraph.checkpoint.postgres import PostgresSaver
from pydantic import BaseModel, Field
from psycopg.errors import UniqueViolation

from . import ai, db, settings
from .core import chunks, extract_text, password_hash, verify_password

@asynccontextmanager
async def lifespan(app):
    db.setup()
    with PostgresSaver.from_conn_string(db.DATABASE_URL) as saver:
        saver.setup()
    yield

app = FastAPI(title='知学', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=Path(__file__).parent.parent / 'static'), name='static')

class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=8, max_length=200)
class CourseIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
class PreferenceIn(BaseModel):
    preference: str = Field(max_length=2000)
class ModelSettingsIn(BaseModel):
    base_url: str = Field(min_length=1, max_length=1000)
    chat_model: str = Field(min_length=1, max_length=200)
    vision_model: str = Field(min_length=1, max_length=200)
    embedding_model: str = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=2000)
    clear_api_key: bool = False

class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    mode: Literal['qa', 'explain', 'review', 'plan', 'quiz'] = 'qa'
    conversation_id: uuid.UUID | None = None
class MistakeIn(BaseModel):
    question: str = Field(min_length=1, max_length=8000)
    answer: str = Field(default='', max_length=8000)


def token_digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def current_user(authorization: str = Header(default='')):
    if not authorization.startswith('Bearer '):
        raise HTTPException(401, '请先登录')
    with db.connection() as conn:
        user = conn.execute('SELECT u.id, u.username, u.preference FROM users u JOIN tokens t ON t.user_id=u.id WHERE t.token_hash=%s AND t.expires_at>now()', (token_digest(authorization[7:]),)).fetchone()
    if not user:
        raise HTTPException(401, '登录已过期')
    return user


def owned_course(conn, user, course_id):
    row = conn.execute('SELECT * FROM courses WHERE id=%s AND user_id=%s', (course_id, user['id'])).fetchone()
    if not row:
        raise HTTPException(404, '课程不存在')
    return row


def cache():
    return redis.Redis.from_url(os.getenv('REDIS_URL', 'redis://localhost:6379/0'), decode_responses=True, socket_connect_timeout=0.3, socket_timeout=0.3)

@app.get('/')
def index():
    return FileResponse(Path(__file__).parent.parent / 'static/index.html')

@app.post('/api/register')
def register(data: Credentials):
    if len(data.username.strip()) < 3:
        raise HTTPException(400, '用户名至少需要 3 个非空字符')
    try:
        with db.connection() as conn:
            conn.execute('INSERT INTO users (username, password_hash) VALUES (%s,%s)', (data.username.strip(), password_hash(data.password)))
    except UniqueViolation:
        raise HTTPException(409, '用户名已存在')
    return {'ok': True}

@app.post('/api/login')
def login(data: Credentials):
    with db.connection() as conn:
        user = conn.execute('SELECT id, password_hash FROM users WHERE username=%s', (data.username.strip(),)).fetchone()
        if not user or not verify_password(data.password, user['password_hash']):
            raise HTTPException(401, '用户名或密码错误')
        token = secrets.token_urlsafe(32)
        conn.execute('INSERT INTO tokens (token_hash,user_id) VALUES (%s,%s)', (token_digest(token), user['id']))
    return {'token':token}

@app.post('/api/logout')
def logout(authorization: str = Header(default=''), user=Depends(current_user)):
    with db.connection() as conn:
        conn.execute('DELETE FROM tokens WHERE token_hash=%s', (token_digest(authorization[7:]),))
    return {'ok':True}

@app.get('/api/me')
def me(user=Depends(current_user)):
    return user

@app.put('/api/me')
def update_me(data: PreferenceIn, user=Depends(current_user)):
    with db.connection() as conn:
        conn.execute('UPDATE users SET preference=%s WHERE id=%s', (data.preference, user['id']))
    return {'ok':True}

@app.get('/api/model-settings')
def get_model_settings(user=Depends(current_user)):
    config = settings.load(user['id'])
    return {k: v for k, v in config.items() if k != 'api_key'} | {'has_key': bool(config['api_key'])}

@app.put('/api/model-settings')
def save_model_settings(data: ModelSettingsIn, user=Depends(current_user)):
    base_url = data.base_url.strip().rstrip('/')
    names = [data.chat_model.strip(), data.vision_model.strip(), data.embedding_model.strip()]
    if not settings.valid_base_url(base_url) or not all(names):
        raise HTTPException(400, '请填写有效的接口地址和模型名称')
    with db.connection() as conn:
        conn.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (user['id'],))
        previous = conn.execute('SELECT * FROM model_settings WHERE user_id=%s', (user['id'],)).fetchone()
        old = previous or settings.defaults()
        has_documents = conn.execute('SELECT EXISTS(SELECT 1 FROM documents d JOIN courses c ON c.id=d.course_id WHERE c.user_id=%s) AS found', (user['id'],)).fetchone()['found']
        if has_documents and (old['base_url'].rstrip('/') != base_url or old['embedding_model'] != names[2]):
            raise HTTPException(409, '已有资料使用当前向量模型建立索引。请先删除所有课程资料，再更改接口地址或向量模型。')
        encrypted = previous['api_key_encrypted'] if previous else ''
        if data.clear_api_key:
            encrypted = ''
        elif data.api_key and data.api_key.strip():
            encrypted = settings.cipher().encrypt(data.api_key.strip().encode()).decode()
        conn.execute('''INSERT INTO model_settings (user_id,base_url,chat_model,vision_model,embedding_model,api_key_encrypted)
          VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (user_id) DO UPDATE SET base_url=EXCLUDED.base_url, chat_model=EXCLUDED.chat_model, vision_model=EXCLUDED.vision_model, embedding_model=EXCLUDED.embedding_model, api_key_encrypted=EXCLUDED.api_key_encrypted''', (user['id'],base_url,*names,encrypted))
    return {'ok': True}

@app.get('/api/courses')
def courses(user=Depends(current_user)):
    with db.connection() as conn:
        return conn.execute('SELECT id,name,created_at FROM courses WHERE user_id=%s ORDER BY id DESC', (user['id'],)).fetchall()

@app.post('/api/courses')
def create_course(data: CourseIn, user=Depends(current_user)):
    name = data.name.strip()
    if not name:
        raise HTTPException(400, '请输入课程名称')
    with db.connection() as conn:
        return conn.execute('INSERT INTO courses (user_id,name) VALUES (%s,%s) RETURNING id,name', (user['id'],name)).fetchone()

@app.get('/api/courses/{course_id}/documents')
def documents(course_id: int, user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        return conn.execute('SELECT id,name,created_at FROM documents WHERE course_id=%s ORDER BY id DESC', (course_id,)).fetchall()

@app.post('/api/courses/{course_id}/documents')
async def upload(course_id: int, file: UploadFile = File(...), user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
    config = settings.load(user['id'])
    if not config['api_key']:
        raise HTTPException(400, '请先在模型设置中配置 API Key')
    data = await file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, '文件不能超过 10 MB')
    name = Path(file.filename or '').name
    suffix = Path(name).suffix.lower()
    try:
        if suffix in ('.png','.jpg','.jpeg','.webp'):
            mime = {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[suffix]
            text = ai.image_text(data, mime, config)
        else:
            text = extract_text(name, data)
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(400, '文件解析失败：' + str(exc))
    except Exception as exc:
        raise HTTPException(502, '文件解析或模型识别失败，请检查文件及模型配置') from exc
    parts = chunks(text)
    if not parts:
        raise HTTPException(400, '未提取到文本；扫描件或含图片的课件请先导出为图片上传')
    if len(parts) > 200:
        raise HTTPException(400, '文档过长，请拆分为不超过 200 个片段的文件')
    try:
        vectors = ai.embeddings(parts, config)
    except ai.EmbeddingError as exc:
        raise HTTPException(502, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, '向量化失败，请检查接口地址、API Key 和向量模型是否可用') from exc
    with db.connection() as conn:
        conn.execute('SELECT id FROM users WHERE id=%s FOR UPDATE', (user['id'],))
        owned_course(conn,user,course_id)
        current = settings.load(user['id'])
        if (current['base_url'].rstrip('/'), current['embedding_model']) != (config['base_url'].rstrip('/'), config['embedding_model']):
            raise HTTPException(409, '模型设置已更改，请重新导入资料')
        existing = conn.execute('''SELECT vector_dims(ch.embedding) AS dim FROM chunks ch JOIN documents d ON d.id=ch.document_id JOIN courses c ON c.id=d.course_id WHERE c.user_id=%s LIMIT 1''', (user['id'],)).fetchone()
        if existing and existing['dim'] != len(vectors[0]):
            raise HTTPException(409, f"当前向量模型返回 {len(vectors[0])} 维，但已有资料使用 {existing['dim']} 维，请恢复原模型或删除资料后重新导入。")
        doc = conn.execute('INSERT INTO documents (course_id,name) VALUES (%s,%s) RETURNING id,name', (course_id,name)).fetchone()
        for part, vector in zip(parts, vectors):
            conn.execute('INSERT INTO chunks (document_id,content,embedding) VALUES (%s,%s,%s::vector)', (doc['id'],part,str(vector)))
    return {**doc,'chunks':len(parts)}

@app.delete('/api/courses/{course_id}/documents/{document_id}')
def delete_document(course_id: int, document_id: int, user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        deleted = conn.execute('DELETE FROM documents WHERE id=%s AND course_id=%s RETURNING id', (document_id, course_id)).fetchone()
        if not deleted:
            raise HTTPException(404, '资料不存在')
    return {'ok':True}

@app.get('/api/courses/{course_id}/conversations')
def conversations(course_id: int, user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        return conn.execute('SELECT id,title,created_at FROM conversations WHERE course_id=%s AND user_id=%s ORDER BY created_at DESC', (course_id,user['id'])).fetchall()

@app.get('/api/courses/{course_id}/conversations/{conversation_id}')
def history(course_id: int, conversation_id: uuid.UUID, user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        conv = conn.execute('SELECT id FROM conversations WHERE id=%s AND user_id=%s AND course_id=%s', (conversation_id,user['id'],course_id)).fetchone()
        if not conv:
            raise HTTPException(404, '会话不存在')
        key = f'conversation:{user["id"]}:{conversation_id}'
        try:
            cached = cache().get(key)
            if cached:
                return json.loads(cached)
        except redis.RedisError:
            pass
        rows = conn.execute('SELECT role,content,created_at FROM messages WHERE conversation_id=%s ORDER BY id', (conversation_id,)).fetchall()
        try:
            cache().setex(key, 3600, json.dumps(rows, default=str, ensure_ascii=False))
        except redis.RedisError:
            pass
        return rows

@app.post('/api/courses/{course_id}/chat')
def chat(course_id: int, data: ChatIn, user=Depends(current_user)):
    config = settings.load(user['id'])
    if not config['api_key']:
        raise HTTPException(400, '请先在模型设置中配置 API Key')
    conversation_id = data.conversation_id or uuid.uuid4()
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        if data.conversation_id:
            row = conn.execute('SELECT id FROM conversations WHERE id=%s AND user_id=%s AND course_id=%s', (conversation_id,user['id'],course_id)).fetchone()
            if not row:
                raise HTTPException(404, '会话不存在')
    try:
        with PostgresSaver.from_conn_string(db.DATABASE_URL) as saver:
            answer = ai.run_agent(user['id'],course_id,conversation_id,data.message,data.mode,user['preference'],saver,config)
    except ai.EmbeddingError as exc:
        raise HTTPException(502, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, '生成失败，请检查模型、网络和数据库配置后重试') from exc
    with db.connection() as conn:
        # The graph stores checkpoints separately using the generated UUID.  Only
        # create the visible conversation after a successful first response, and
        # commit it together with its messages.
        if not data.conversation_id:
            conn.execute('INSERT INTO conversations (id,user_id,course_id,title) VALUES (%s,%s,%s,%s)', (conversation_id,user['id'],course_id,data.message[:40]))
        conn.execute('INSERT INTO messages (conversation_id,role,content) VALUES (%s,%s,%s),(%s,%s,%s)', (conversation_id,'user',data.message,conversation_id,'assistant',answer))
    try:
        key = f'conversation:{user["id"]}:{conversation_id}'
        cache().delete(key)
    except redis.RedisError:
        pass
    return {'conversation_id':str(conversation_id),'answer':answer}

@app.get('/api/courses/{course_id}/mistakes')
def mistakes(course_id: int, user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        return conn.execute('SELECT id,question,answer,created_at FROM mistakes WHERE course_id=%s AND user_id=%s ORDER BY id DESC', (course_id,user['id'])).fetchall()

@app.post('/api/courses/{course_id}/mistakes')
def add_mistake(course_id: int, data: MistakeIn, user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        return conn.execute('INSERT INTO mistakes (user_id,course_id,question,answer) VALUES (%s,%s,%s,%s) RETURNING id', (user['id'],course_id,data.question,data.answer)).fetchone()

@app.delete('/api/courses/{course_id}/mistakes/{mistake_id}')
def delete_mistake(course_id: int, mistake_id: int, user=Depends(current_user)):
    with db.connection() as conn:
        owned_course(conn,user,course_id)
        deleted = conn.execute('DELETE FROM mistakes WHERE id=%s AND course_id=%s AND user_id=%s RETURNING id', (mistake_id,course_id,user['id'])).fetchone()
        if not deleted:
            raise HTTPException(404, '错题不存在')
    return {'ok':True}
