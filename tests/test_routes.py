import unittest
import uuid
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException

from app import main


class Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeDatabase:
    """A small in-memory stand-in for the queries used by these routes."""

    def __init__(self):
        self.courses = {(7, 1)}
        self.mistakes = {(11, 7, 1), (12, 7, 2), (13, 8, 1)}
        self.conversations = {}
        self.messages = []
        self.writes = []

    @contextmanager
    def connection(self):
        yield self

    def execute(self, sql, params):
        if sql.startswith('SELECT * FROM courses'):
            return Result({'id': params[0]} if tuple(params) in self.courses else None)
        if sql.startswith('DELETE FROM mistakes'):
            key = tuple(params)
            if key in self.mistakes:
                self.mistakes.remove(key)
                return Result({'id': key[0]})
            return Result()
        if sql.startswith('SELECT id FROM conversations'):
            conv_id, user_id, course_id = params
            return Result({'id': conv_id} if self.conversations.get(conv_id) == (user_id, course_id) else None)
        if sql.startswith('INSERT INTO conversations'):
            conv_id, user_id, course_id, title = params
            self.conversations[conv_id] = (user_id, course_id)
            self.writes.append(('conversation', conv_id, title))
            return Result()
        if sql.startswith('INSERT INTO messages'):
            self.messages.extend([(params[0], params[1], params[2]), (params[3], params[4], params[5])])
            self.writes.append(('messages', params[0]))
            return Result()
        raise AssertionError(f'Unexpected query: {sql}')


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()
        self.user = {'id': 1, 'preference': ''}
        self.db_patch = patch.object(main.db, 'connection', self.database.connection)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)

    def test_delete_mistake_only_removes_owned_item_in_owned_course(self):
        self.assertEqual(main.delete_mistake(7, 11, self.user), {'ok': True})
        self.assertNotIn((11, 7, 1), self.database.mistakes)
        for mistake_id in (11, 12, 13, 999):
            with self.subTest(mistake_id=mistake_id):
                with self.assertRaises(HTTPException) as caught:
                    main.delete_mistake(7, mistake_id, self.user)
                self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(self.database.mistakes, {(12, 7, 2), (13, 8, 1)})

    def test_delete_mistake_rejects_course_not_owned_by_user(self):
        with self.assertRaises(HTTPException) as caught:
            main.delete_mistake(8, 13, self.user)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn((13, 8, 1), self.database.mistakes)

    def chat_patches(self):
        return (
            patch.object(main.settings, 'load', return_value={'api_key': 'test-key'}),
            patch.object(main.PostgresSaver, 'from_conn_string'),
            patch.object(main, 'cache'),
        )

    def test_failed_first_response_does_not_create_a_conversation(self):
        settings_patch, saver_patch, cache_patch = self.chat_patches()
        with settings_patch, saver_patch, cache_patch, patch.object(main.ai, 'run_agent', side_effect=RuntimeError('unavailable')):
            with self.assertRaises(HTTPException) as caught:
                main.chat(7, main.ChatIn(message='问题'), self.user)
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(self.database.conversations, {})
        self.assertEqual(self.database.messages, [])
        self.assertEqual(self.database.writes, [])

    def test_successful_first_response_saves_conversation_and_messages(self):
        settings_patch, saver_patch, cache_patch = self.chat_patches()
        with settings_patch, saver_patch, cache_patch, patch.object(main.ai, 'run_agent', return_value='回答') as agent:
            result = main.chat(7, main.ChatIn(message='问题'), self.user)
        conv_id = uuid.UUID(result['conversation_id'])
        self.assertEqual(agent.call_args.args[2], conv_id)
        self.assertEqual(self.database.conversations[conv_id], (1, 7))
        self.assertEqual(self.database.messages, [(conv_id, 'user', '问题'), (conv_id, 'assistant', '回答')])
        self.assertEqual(result['answer'], '回答')

    def test_follow_up_uses_existing_conversation(self):
        conv_id = uuid.uuid4()
        self.database.conversations[conv_id] = (1, 7)
        settings_patch, saver_patch, cache_patch = self.chat_patches()
        with settings_patch, saver_patch, cache_patch, patch.object(main.ai, 'run_agent', return_value='回答'):
            result = main.chat(7, main.ChatIn(message='追问', conversation_id=conv_id), self.user)
        self.assertEqual(result['conversation_id'], str(conv_id))
        self.assertEqual([item[0] for item in self.database.writes], ['messages'])


if __name__ == '__main__':
    unittest.main()
