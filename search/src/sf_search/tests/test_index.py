import unittest
from ..index import create_index, search_index

class TestIndexFunctions(unittest.TestCase):
    def test_create_and_search_index(self):
        # Create index
        code1 = {'code': 'def f(a,b): if a>b: return a else return b', 'metadata': 'max'}
        code2 = {'code': 'def f(a,b): if a<b: return a else return b', 'metadata': 'min'}
        index = create_index([code1, code2])

        # Search index
        query = 'return maximum value'
        results = search_index(index, query)

        # Verify results
        self.assertTrue(len(results) > 0)
        self.assertEqual(results[0]['metadata'], 'max')

if __name__ == '__main__':
    unittest.main()
