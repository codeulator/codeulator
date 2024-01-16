import fs from 'fs';
import os from 'os';
import path from 'path';

import { addToIndex, searchIndex, defaultIndexFileName } from './search';

describe('Search Functions', () => {
    it('should add to index and search', async () => {
        // Create temp directory
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
        const indexPath = path.join(tempDir, defaultIndexFileName);

        // Add to index
        const filename = 'hello.py';
        const content = Buffer.from('def f(a,b): if a>b: return a else return b');
        await addToIndex(indexPath, filename, content);

        // Search index
        const query = 'return maximum value';
        const results = await searchIndex(indexPath, query);

        // Verify results
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].score).toBeGreaterThan(0.3);

        // Delete temp directory
        fs.rmSync(indexPath, { recursive: true, force: true });
    }, 15000 /* timeout */);
});
