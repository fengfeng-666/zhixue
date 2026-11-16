import os
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from pgvector.psycopg import register_vector

DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://zhixue:zhixue@localhost:5432/zhixue')

@contextmanager
def connection():
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        register_vector(conn)
        yield conn


def setup():
    with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
        conn.execute('CREATE EXTENSION IF NOT EXISTS vector')
        conn.execute('''
        CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, preference TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS tokens (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days');
        CREATE TABLE IF NOT EXISTS courses (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS documents (id BIGSERIAL PRIMARY KEY, course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS chunks (id BIGSERIAL PRIMARY KEY, document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, content TEXT NOT NULL, embedding vector(1536) NOT NULL);
        CREATE INDEX IF NOT EXISTS chunks_vector_idx ON chunks USING hnsw (embedding vector_cosine_ops);
        CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), course_id BIGINT NOT NULL REFERENCES courses(id), title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS mistakes (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), course_id BIGINT NOT NULL REFERENCES courses(id), question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
        ''')
