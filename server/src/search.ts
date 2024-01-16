import path from 'path';
import Parser from 'tree-sitter';
import sqlite3 from 'sqlite3';
import languages from './languages';
import { spawn } from 'node:child_process';

export const defaultIndexFileName = 'sf_search.sqlite';
export const searchableFileExtensions = ['.java', '.rb', '.py', '.php', '.js', '.ts', '.go'];
export const fileSizeLimit = 1000000;

export type SearchResult = {
    path: string;
    name: string;
    row: number;
    col: number;
    score: number;
};

/*
python -m sf_search create
  stdin: [{code: '...', name, row, col}, ...]
  stdout: [{embedding: [...], name, row, col}, ...]
python -m sf_search query 
  stdin: {query: '...', index: [...]}
  stdout: [{name, row, col, score}, ...]
*/

function runAuxiliarySearchTool(args: string[], input: Buffer | string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('python', ['-m', 'sf_search', ...args]);
        let output = Buffer.alloc(0);

        child.stdin.write(input);
        child.stdin.end();

        child.stdout.on('data', (data) => {
            output = Buffer.concat([output, data]);
        });

        child.stderr.on('data', (data) => {
            console.error(data.toString('utf-8'));
        });

        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Process exited with code ${code}`));
            } else {
                resolve(output);
            }
        });
    });
}

export async function addToIndex(
    indexPath: string,
    filename: string,
    content: Buffer,
    nodeTypes: string[] = ['function_definition']
) {
    const extension = path.extname(filename);
    const language = languages[extension];

    if (!language || !language.parser) {
        throw new Error(`Unsupported file extension '${extension}'.`);
    }

    //TODO: fast exit if file hasn't changed

    const parser = new Parser();
    parser.setLanguage(language.parser);

    const tree = parser.parse(content.toString('utf-8')); //TODO: async?
    const cursor = tree.walk();

    if (!cursor.gotoFirstChild()) {
        return;
    }

    const functions: { name: string; row: number; col: number; code: string }[] = [];

    // Find all relevant nodes
    while (cursor.currentNode !== tree.rootNode) {
        const node = cursor.currentNode;
        if (node.isNamed && nodeTypes.includes(node.type)) {
            functions.push({
                name: node.firstChild.text,
                row: node.startPosition.row,
                col: node.startPosition.column,
                code: content.toString('utf-8', node.startIndex, node.endIndex),
            });
        }

        if (!cursor.gotoFirstChild() && !cursor.gotoNextSibling()) {
            while (cursor.gotoParent() && !cursor.gotoNextSibling()) {
                // Keep going up to the parent until there is a sibling or no parent
            }
        }
    }

    // Create the index
    const index = await runAuxiliarySearchTool(['create'], JSON.stringify(functions));

    // Save the index to the database
    return new Promise<void>((resolve, reject) => {
        const db = new sqlite3.Database(indexPath);
        db.serialize(() => {
            db.run(
                'CREATE TABLE IF NOT EXISTS file_index (filename TEXT PRIMARY KEY, extension TEXT, index_v1 BLOB, utc_timestamp INTEGER)'
            );
            const stmt = db.prepare('INSERT OR REPLACE INTO file_index VALUES (?, ?, ?, ?)');
            stmt.run(filename, extension, index, Date.now());
            stmt.finalize((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    });
}

type FileIndexRow = {
    filename: string;
    extension: string;
    index_v1: Buffer;
};

export async function searchIndex(
    indexPath: string,
    query: string,
    filter?: { filename?: string; extension?: string }
) {
    const db = new sqlite3.Database(indexPath);
    const rows = await new Promise<FileIndexRow[]>((resolve, reject) => {
        // Construct the query
        let sql = 'SELECT filename, index_v1 FROM file_index';
        const params: any[] = [];
        if (filter?.filename) {
            sql += ' WHERE filename = ?';
            params.push(filter.filename);
        } else if (filter?.extension) {
            sql += ' WHERE extension = ?';
            params.push(filter.extension);
        }

        // Execute the query
        db.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows as FileIndexRow[]);
            }
        });
    });

    if (!rows) {
        return [];
    }

    const results: SearchResult[] = [];

    for (const row of rows) {
        const output = await runAuxiliarySearchTool(['search', query], row.index_v1);
        const fileResults = JSON.parse(output.toString('utf-8')) as SearchResult[];
        results.push(...fileResults.map((result) => ({ ...result, path: row.filename })));
    }

    return results;
}
