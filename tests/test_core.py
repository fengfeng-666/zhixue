import unittest
from app.core import chunks, extract_text, keywords, password_hash, verify_password

class CoreTests(unittest.TestCase):
    def test_password_roundtrip(self):
        stored = password_hash('correct horse')
        self.assertTrue(verify_password('correct horse', stored))
        self.assertFalse(verify_password('wrong', stored))
        self.assertFalse(verify_password('wrong', 'bad'))
    def test_chunks_overlap(self):
        self.assertEqual(chunks('abcdefghij', 5, 2), ['abcde', 'defgh', 'ghij'])
        self.assertEqual(chunks('  '), [])
        with self.assertRaises(ValueError): chunks('a', 5, 5)
    def test_keywords_chinese(self):
        self.assertEqual(keywords('机器学习 RAG'), ['机器', '器学', '学习', 'rag'])
    def test_text_extract(self):
        self.assertEqual(extract_text('hello.txt', '你好'.encode()), '你好')
        with self.assertRaises(ValueError): extract_text('file.exe', b'abc')

if __name__ == '__main__': unittest.main()
