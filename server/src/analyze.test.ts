import { FileType } from './filesystem';
import {
    analyzeFile,
    analyzeDirectory,
    AnalyzeFileOptions,
    AnalyzeDirectoryOptions,
    AnalyzeFileResult,
    DirectoryEntry,
} from './analyze';

const mockFs = {
    stat: jest.fn(),
    readFile: jest.fn(),
    readDirectory: jest.fn(),
};

describe('analyzeFile', () => {
    it('reads lines from a file within a range', async () => {
        const uri = { path: 'file.txt' };
        const options: AnalyzeFileOptions = {
            fs: mockFs,
            path: uri.path,
            startLine: 1,
            endLine: 2,
        };

        mockFs.stat.mockResolvedValueOnce({ type: FileType.File, size: 50 });
        mockFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('line1\nline2\nline3\nline4\nline5'));

        const expected: AnalyzeFileResult = {
            data: '1: line1\n2: line2',
        };

        await expect(analyzeFile(options)).resolves.toEqual(expected);
    });

    it('truncates the file based on character limit', async () => {
        const uri = { path: 'file.txt' };
        const options: AnalyzeFileOptions = {
            fs: mockFs,
            path: uri.path,
            characterLimit: 13,
        };

        mockFs.stat.mockResolvedValueOnce({ type: FileType.File, size: 50 });
        mockFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('123456789\nabcdefghij\nABCDEFGHIJ'));

        const expected: AnalyzeFileResult = {
            data: 'WARNING: This file is too large to display, so it was truncated. Read from line 2 for remaining data.\n\n1: 123456789',
        };

        await expect(analyzeFile(options)).resolves.toEqual(expected);
    });
});

describe('analyzeDirectory', () => {
    it('reads the contents of a directory', async () => {
        const uri = { path: 'mydir' };
        const options: AnalyzeDirectoryOptions = { fs: mockFs, path: uri.path, cacheDir: '/tmp' };

        mockFs.stat.mockResolvedValueOnce({ type: FileType.Directory });
        mockFs.readDirectory.mockResolvedValueOnce([
            ['file1.txt', FileType.File],
            ['subdir', FileType.Directory],
        ]);

        const expected: DirectoryEntry = {
            name: 'mydir',
            type: 'dir',
            children: [
                ['file', 'file1.txt'],
                ['dir', 'subdir'],
            ],
        };

        await expect(analyzeDirectory(options)).resolves.toEqual(expected);
    });

    it('reads nested directories when depth is greater than 1', async () => {
        const uri = { path: 'mydir' };
        const options: AnalyzeDirectoryOptions = { fs: mockFs, path: uri.path, depth: 2, cacheDir: '/tmp' };

        mockFs.stat
            .mockResolvedValueOnce({ type: FileType.Directory }) // dir
            .mockResolvedValueOnce({ type: FileType.Directory }); // dir/subdir

        mockFs.readDirectory
            .mockResolvedValueOnce([
                ['file1.txt', FileType.File],
                ['subdir', FileType.Directory],
            ])
            .mockResolvedValueOnce([['file2.txt', FileType.File]]);

        const expected: DirectoryEntry = {
            name: 'mydir',
            type: 'dir',
            children: [
                ['file', 'file1.txt'],
                {
                    name: 'subdir',
                    type: 'dir',
                    children: [['file', 'file2.txt']],
                },
            ],
        };

        await expect(analyzeDirectory(options)).resolves.toEqual(expected);
    });
});
