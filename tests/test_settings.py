import os
import tempfile
import unittest
from unittest.mock import patch
from app.settings import cipher, valid_base_url

class ModelSettingsTests(unittest.TestCase):
    def test_key_persists_and_decrypts(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'ZHIXUE_DATA_DIR': directory}, clear=False):
            os.environ.pop('ZHIXUE_ENCRYPTION_KEY', None)
            encrypted = cipher().encrypt(b'example-secret')
            self.assertNotIn(b'example-secret', encrypted)
            self.assertEqual(cipher().decrypt(encrypted), b'example-secret')
            self.assertEqual(os.stat(os.path.join(directory, 'model-key')).st_mode & 0o777, 0o600)

    def test_base_url_validation(self):
        self.assertTrue(valid_base_url('https://example.com/v1'))
        self.assertTrue(valid_base_url('http://localhost:8080/v1'))
        self.assertFalse(valid_base_url('file:///etc/passwd'))
        self.assertFalse(valid_base_url('https://user:secret@example.com/v1'))
        self.assertFalse(valid_base_url('https://example.com/v1?api_key=secret'))

if __name__ == '__main__':
    unittest.main()
