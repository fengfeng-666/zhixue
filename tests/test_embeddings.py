import unittest
from types import SimpleNamespace
from unittest.mock import patch
from app import ai

class EmbeddingTests(unittest.TestCase):
    def test_uses_provider_default_dimension(self):
        endpoint = SimpleNamespace(create=lambda **kwargs: SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[1.0] * 1024)]))
        fake = SimpleNamespace(embeddings=endpoint)
        with patch.object(ai, 'client', return_value=fake):
            self.assertEqual(len(ai.embeddings(['text'], {'embedding_model':'example'})[0]), 1024)

    def test_rejects_missing_and_invalid_vectors(self):
        for items in ([], [SimpleNamespace(index=0, embedding=[float('nan')])], [SimpleNamespace(index=0, embedding=[0.0])]):
            fake = SimpleNamespace(embeddings=SimpleNamespace(create=lambda **kwargs: SimpleNamespace(data=items)))
            with self.subTest(items=items), patch.object(ai, 'client', return_value=fake):
                with self.assertRaises(ai.EmbeddingError):
                    ai.embeddings(['text'], {'embedding_model':'example'})

if __name__ == '__main__': unittest.main()
