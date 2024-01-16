import path from 'path';
import Parser from 'tree-sitter';
import languages from './languages';

const nodesToStrip = new Set([
    'binary_expression',
    'declaration',
    'expression_statement',
    'lexical_declaration',
    'parenthesized_expression',
]);

export const supportedFileExtensions = Object.entries(languages)
    .filter(([ext, language]) => !!language.parser)
    .map(([ext]) => ext);

export function squashCode(filename: string, lines: string[]) {
    const extension = path.extname(filename);
    const language = languages[extension];

    if (!language || !language.parser) {
        throw new Error(`Unsupported file extension '${extension}'.`);
    }

    const parser = new Parser();
    parser.setLanguage(language.parser);

    const tree = parser.parse((index, position) => {
        let line = lines[position.row];
        if (line !== undefined) {
            return line.slice(position.column) + '\n';
        }
    });

    const cursor = tree.walk();
    const replacementRanges: Range[] = [];

    if (!cursor.gotoFirstChild()) {
        return lines;
    }

    while (cursor.currentNode !== tree.rootNode) {
        const node = cursor.currentNode;
        if (node.isNamed && nodesToStrip.has(node.type)) {
            replacementRanges.push({
                start: node.startPosition,
                end: node.endPosition,
            });
        }

        if (!cursor.gotoFirstChild() && !cursor.gotoNextSibling()) {
            while (cursor.gotoParent() && !cursor.gotoNextSibling()) {
                // Keep going up to the parent until there is a sibling or no parent
            }
        }
    }

    let outputLines = [...lines];

    for (let range of collapseRanges(replacementRanges)) {
        for (let i = range.start.row; i <= range.end.row; i++) {
            if (i === range.start.row && i === range.end.row) {
                outputLines[i] = replaceRange(outputLines[i], range.start.column, range.end.column, '...');
            } else if (i === range.start.row) {
                outputLines[i] = replaceRange(
                    outputLines[i],
                    range.start.column,
                    outputLines[i].length,
                    '...'
                );
            } else if (i === range.end.row) {
                outputLines[i] = replaceRange(outputLines[i], 0, range.end.column, '...');
            } else {
                outputLines[i] = '...';
            }
        }
    }

    return outputLines;
}

function replaceRange(s: string, start: number, end: number, substitute: string) {
    return s.substring(0, start) + substitute + s.substring(end);
}

type Range = { start: Parser.Point; end: Parser.Point };

function collapseRanges(ranges: Range[]) {
    if (ranges.length < 2) {
        return ranges;
    }

    // Sort ranges by start row, then by start column
    ranges.sort((a, b) => {
        if (a.start.row !== b.start.row) {
            return a.start.row - b.start.row;
        }
        return a.start.column - b.start.column;
    });

    let simplifiedRanges: Range[] = [];
    let currentRange = ranges[0];

    for (let i = 1; i < ranges.length; i++) {
        let nextRange = ranges[i];

        // If current range overlaps or is adjacent with next range
        if (
            currentRange.end.row > nextRange.start.row ||
            (currentRange.end.row === nextRange.start.row &&
                currentRange.end.column >= nextRange.start.column)
        ) {
            // Merge the two ranges
            currentRange = {
                start: currentRange.start,
                end: {
                    row: Math.max(currentRange.end.row, nextRange.end.row),
                    column: Math.max(currentRange.end.column, nextRange.end.column),
                },
            };
        } else {
            // Push the non-overlapping current range into the simplified array
            simplifiedRanges.push(currentRange);
            currentRange = nextRange;
        }
    }

    // Push the last range into the simplified array
    simplifiedRanges.push(currentRange);

    return simplifiedRanges;
}
