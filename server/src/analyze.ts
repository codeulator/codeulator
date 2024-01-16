import type { Uri } from 'vscode';
import path from 'path';
import localFs from 'fs/promises';

import { FileType, ReadableFileSystem } from './filesystem';
import { squashCode, supportedFileExtensions } from './squashCode';
import { SafeError } from './errors';

import {
    addToIndex,
    searchIndex,
    defaultIndexFileName,
    searchableFileExtensions,
    fileSizeLimit as searchSizeLimit,
    SearchResult,
} from './search';

enum Selector {
    Xterm = `#terminal .terminal-wrapper`,
}

interface PlaywrightDriver {
    getTerminalBuffer(selector: string): Promise<string[]>;
}

export interface AnalyzeFileOptions {
    fs: ReadableFileSystem;
    path: string;
    characterLimit?: number;
    startLine?: number;
    endLine?: number;
    allowSquashing?: boolean;
    squashThreshold?: number;
    driver?: PlaywrightDriver;
}

export interface AnalyzeFileResult {
    data: string;
}

export interface AnalyzeDirectoryOptions {
    fs: ReadableFileSystem;
    path: string;
    depth?: number; // defaults to 1 (i.e. read only the top-level directory)
    ignore?: string[]; // globs relative to `path`
    getFileSizes?: boolean;
    cacheDir: string;
    semanticQuery?: string;
}

interface FullDirectoryEntry {
    name: string;
    type: 'file' | 'dir';
    size?: number;
    children?: DirectoryEntry[];
    score?: number;
    line?: number;
    warnings?: Set<string>;
}

type CompactDirectoryEntry = ['file' | 'dir', string];

export type DirectoryEntry = FullDirectoryEntry | CompactDirectoryEntry;

export async function analyzeFile(options: AnalyzeFileOptions): Promise<AnalyzeFileResult> {
    const {
        fs,
        path: filePath,
        characterLimit = 10000,
        allowSquashing: allowSquashing = true,
        squashThreshold: squashThreshold = 2500,
        driver,
    } = options;

    // Account for the fact that lines are 1-indexed and ranges are inclusive
    let { startLine = 1, endLine } = options;
    startLine--;

    let allLines: string[];
    const warnings = [];

    if (driver && filePath === 'terminal') {
        // Special case for fetching the shared terminal buffer
        try {
            allLines = (await driver.getTerminalBuffer(Selector.Xterm)).map((line) =>
                line.replace('Host shared a Live Share terminal. Enter to type.', '')
            );
        } catch (error) {
            throw new SafeError('Failed to get terminal contents. Is the terminal open?');
        }

        // By default, only show recent history
        if (!options.startLine && !options.endLine) {
            startLine = Math.max(0, allLines.length - 50);
            if (startLine > 0) {
                warnings.push('WARNING: Only showing recent history. For more, request previous lines.');
            }
        }
    } else {
        // Ensure the file exists
        const uri = { scheme: 'file', path: filePath } as Uri;
        const fileStat = await fs.stat(uri);

        if (fileStat.type == FileType.Unknown) {
            throw new SafeError({ message: `File not found: ${filePath}`, sensitive: true });
        } else if (fileStat.type === FileType.Directory) {
            throw new SafeError({ message: `Is a directory: ${filePath}`, sensitive: true });
        }

        // For real files, use the FileSystem interface
        const fileContent = new TextDecoder().decode(await fs.readFile(uri));
        allLines = fileContent.split('\n');
    }

    let lines = allLines.slice(startLine, endLine);
    let truncated = false,
        squashed = false;
    const characterCount = lines.join('\n').length;

    // Strip out certain statements if the file is large enough
    if (
        allowSquashing &&
        characterCount > squashThreshold &&
        supportedFileExtensions.includes(path.extname(filePath))
    ) {
        lines = squashCode(path.basename(filePath), lines);
        squashed = true;
    }

    // Add line numbers
    for (let i = 0; i < (endLine - startLine || lines.length); i++) {
        lines[i] = (startLine + i + 1).toString() + ': ' + lines[i];
    }

    if (characterCount > characterLimit) {
        const truncatedLines = [];
        let countedCharacters = 0;

        for (const line of lines) {
            // account for the newline character's length
            if (countedCharacters + line.length + 1 > characterLimit) {
                break;
            }
            truncatedLines.push(line);
            countedCharacters += line.length + 1; // +1 for the newline character
        }

        const nextLine = startLine + truncatedLines.length + 1;
        warnings.push(
            'WARNING: This file is too large to display, so it was truncated. ' +
                `Read from line ${nextLine} for remaining data.`
        );

        lines = truncatedLines;
        truncated = true;
    }

    if (squashed) {
        warnings.push(
            'WARNING: For performance reasons, some portions of this file are not shown ' +
                '(replaced with ellipses). To see full content, read specific line ranges.'
        );

        const collapsedLines = collapseSequentialEllipsis(lines as LineWithNumberPrefix[]);
        if (collapsedLines.length < lines.length) {
            lines = collapsedLines.filter((line) => !/^\d+: (\.{3}:?)?$/.test(line));
            warnings.push('WARNING: Some lines are omitted entirely.');
        }
    }

    let data = '';
    if (warnings.length) {
        data += warnings.join('\n') + '\n\n';
    }
    data += lines.join('\n');

    if (lines.length && lines[lines.length - 1].startsWith(allLines.length + ':')) {
        data += '\nEnd of file';
    }

    return { data };
}

export async function analyzeDirectory(options: AnalyzeDirectoryOptions): Promise<DirectoryEntry> {
    const {
        fs: remoteFs,
        path: dirPath = '/',
        depth = 1,
        ignore = [],
        getFileSizes,
        semanticQuery,
        cacheDir,
    } = options;

    const uri = { scheme: 'file', path: dirPath } as Uri;
    const fileStat = await remoteFs.stat(uri);

    if (fileStat.type == FileType.Unknown) {
        throw new SafeError({ message: `Directory not found: ${dirPath}`, sensitive: true });
    } else if (fileStat.type !== FileType.Directory) {
        throw new SafeError({ message: `Not a directory: ${dirPath}`, sensitive: true });
    }

    const indexPath = path.join(cacheDir, defaultIndexFileName);
    if (semanticQuery && depth > 1) {
        throw new SafeError('Recursive semantic search is not supported. Use depth=1.');
    }

    let result: DirectoryEntry = {
        name: dirPath.split('/').pop()!,
        type: 'dir',
        children: [],
        warnings: new Set(),
    };

    const isIgnored = (name: string) => ignore.includes(name);

    for (const [name, type] of await remoteFs.readDirectory(uri)) {
        if (isIgnored(name)) {
            continue;
        }

        if (type === FileType.File) {
            const filePath = path.join(dirPath, name);
            const extension = path.extname(name);

            // If a semantic search was requested, find the best match in the file
            let bestSearchResult: SearchResult | undefined;
            if (semanticQuery) {
                result.warnings.add('Semantic search is temporarily unavailable');

                /*if (!searchableFileExtensions.includes(extension)) {
                    result.warnings.add(`Semantic search is not supported for ${extension} files`);
                }
                if (fileStat.size > searchSizeLimit) {
                    result.warnings.add(
                        `Semantic search was skipped for files larger than ${searchSizeLimit} bytes`
                    );
                }

                // Download and index the file
                const fileContent = Buffer.from(await remoteFs.readFile(uri));
                await addToIndex(indexPath, filePath, fileContent); // no-op if already indexed

                // Run the search and store the best result for this file
                const searchResults = await searchIndex(indexPath, semanticQuery, { filename: filePath });
                for (const searchResult of searchResults) {
                    if (searchResult.score > bestSearchResult.score) {
                        bestSearchResult = searchResult;
                    }
                }*/
            }

            if (getFileSizes || semanticQuery) {
                const fileUri = { scheme: 'file', path: filePath } as Uri;
                const fileStat = await remoteFs.stat(fileUri);

                let child: FullDirectoryEntry = {
                    name,
                    type: 'file',
                    size: fileStat.size,
                };

                // Add search result info
                /*if (bestSearchResult) {
                    child.score = bestSearchResult.score;
                    child.line = bestSearchResult.row;
                } else if (semanticQuery) {
                    child.score = 0;
                }*/

                result.children.push(child);
            } else {
                // Use the compact format
                result.children.push(['file', name]);
            }
        } else if (type === FileType.Directory) {
            const subDirectoryResult: DirectoryEntry = {
                name,
                type: 'dir',
            };

            if (depth > 20) {
                throw new SafeError('Directory depth limit exceeded');
            } else if (depth > 1) {
                const subDirectoryOptions: AnalyzeDirectoryOptions = {
                    fs: remoteFs,
                    path: path.join(dirPath, name),
                    depth: depth - 1,
                    ignore,
                    cacheDir,
                };
                const fullResult = await analyzeDirectory(subDirectoryOptions);
                if ('children' in fullResult) {
                    subDirectoryResult.children = fullResult.children;
                }
            }

            if (subDirectoryResult.children?.length) {
                result.children.push(subDirectoryResult);
            } else {
                result.children.push(['dir', name]);
            }
        }
    }

    return result;
}

type LineWithNumberPrefix = `${number}: ${string}`;

function collapseSequentialEllipsis(lines: LineWithNumberPrefix[]) {
    let collapsedLines = [];
    let wasLastLineEllipsis = false;

    for (let line of lines) {
        const [lineNumber, code] = line.split(': ');
        const isCurrentLineEllipsis = code.trim().endsWith('...');

        if (!isCurrentLineEllipsis || !wasLastLineEllipsis) {
            collapsedLines.push(line);
        }

        wasLastLineEllipsis = isCurrentLineEllipsis;
    }

    return collapsedLines;
}
