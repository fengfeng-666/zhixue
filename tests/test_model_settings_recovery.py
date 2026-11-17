import unittest
from contextlib import contextmanager
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app import main, settings


class Result:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class ModelSettingsDatabase:
    def __init__(self, encrypted):
        self.row = {
            'base_url': 'https://example.com/v1',
            'chat_model': 'chat',
            'vision_model': 'vision',
            'embedding_model': 'embedding',
            'api_key_encrypted': encrypted,
        }
        self.writes = []

    @contextmanager
    def connection(self):
        yield self

    def execute(self, sql, params):
        if sql.startswith('SELECT base_url') or sql.startswith('SELECT * FROM model_settings'):
            return Result(self.row)
        if sql.startswith('SELECT id FROM users'):
            return Result({'id': 1})
        if sql.startswith('SELECT EXISTS'):
            return Result({'found': False})
        if sql.startswith('INSERT INTO model_settings'):
            self.writes.append(params)
            return Result(None)
        raise AssertionError(f'Unexpected query: {sql}')


class ModelSettingsRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.cipher = Fernet(Fernet.generate_key())
        old_cipher = Fernet(Fernet.generate_key())
        self.database = ModelSettingsDatabase(old_cipher.encrypt(b'original-test-key').decode())
        self.patches = [
            patch.object(settings, 'connection', self.database.connection),
            patch.object(main.db, 'connection', self.database.connection),
            patch.object(settings, 'cipher', return_value=self.cipher),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        main.app.dependency_overrides[main.current_user] = lambda: {'id': 1, 'preference': ''}
        self.addCleanup(main.app.dependency_overrides.pop, main.current_user, None)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.payload = {
            'base_url': 'https://example.com/v1',
            'chat_model': 'chat',
            'vision_model': 'vision',
            'embedding_model': 'embedding',
        }

    def test_unreadable_key_leaves_settings_accessible_without_exposing_it(self):
        response = self.client.get('/api/model-settings')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['key_error'])
        self.assertTrue(data['has_personal_key'])
        self.assertFalse(data['has_key'])
        self.assertNotIn('api_key', data)
        self.assertNotIn('api_key_encrypted', data)
        self.assertEqual(data['chat_model'], 'chat')

    def test_chat_and_unchanged_save_report_a_recoverable_conflict(self):
        response = self.client.post('/api/courses/1/chat', json={'message': 'test'})
        self.assertEqual(response.status_code, 409)
        self.assertIn('无法解密', response.json()['detail'])
        response = self.client.put('/api/model-settings', json=self.payload)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.database.writes, [])

    def test_replacing_or_removing_an_unreadable_key(self):
        response = self.client.put('/api/model-settings', json={**self.payload, 'api_key': 'replacement-test-key'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.cipher.decrypt(self.database.writes[-1][-1].encode()), b'replacement-test-key')
        response = self.client.put('/api/model-settings', json={**self.payload, 'clear_api_key': True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.database.writes[-1][-1], '')

    def test_readable_key_keeps_existing_behavior(self):
        self.database.row['api_key_encrypted'] = self.cipher.encrypt(b'valid-test-key').decode()
        response = self.client.get('/api/model-settings')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()['key_error'])
        self.assertTrue(response.json()['has_key'])
        response = self.client.put('/api/model-settings', json=self.payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.database.writes[-1][-1], self.database.row['api_key_encrypted'])


if __name__ == '__main__':
    unittest.main()
