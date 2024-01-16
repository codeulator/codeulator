import argparse, json, logging, sys
from .index import create_index, search_index

def main():
    parser = argparse.ArgumentParser(prog="sf_search", description="Search for code blocks using natural language queries.")
    subparsers = parser.add_subparsers(dest='command')

    parser.add_argument("-v", "--verbose", action="store_true", help="Print verbose output. (default: false)")

    create_parser = subparsers.add_parser("create", help="""Generates a search index from blocks of code.
Reads a JSON array of objects from stdin, and writes an array of the same length to stdout.
Input objects must contain 'code' (string), which will be replaced with 'embedding' (array).""")

    search_parser = subparsers.add_parser("search", help="""Searches an index that was generated with the `create` command.
Reads a JSON array from stdin, and writes an array of results to stdout.
Each result will contain 'score' (number). Results will be sorted by score in descending order.""")
    search_parser.add_argument("query")
    search_parser.add_argument("-l", "--limit", type=int, default=5, help="Maximum number of search results to return. (default: 5)")
    search_parser.add_argument("-t", "--threshold", type=float, default=0.3, help="Minimum similarity threshold for search results. (default: 0.3)")

    args = parser.parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)

    if args.command == 'create':
        for line in sys.stdin:
            print(json.dumps(create_index(json.loads(line))))
    elif args.command == 'search':
        for line in sys.stdin:
            print(json.dumps(search_index(json.loads(line), args.query, args.limit, args.threshold)))

if __name__ == '__main__':
    main()
