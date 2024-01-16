import type { Request, Response } from 'express';
import type { Application } from 'vscode-automation';
import type { Server } from '../server';
import { SafeError, handleErrors } from '../errors';

function escapeString(str: string) {
    str = str.replace(/[.*+?^$()/|[\]\\]/g, '\\$&'); // $& is the whole matched string
    return str.replace(/\n/g, '\\n');
}

export async function dispatchKeys(app: Application, keys: string) {
    for (let key of keys) {
        await app.code.dispatchKeybinding(key.replace('\n', 'enter'));
    }
}

export default async function edit(this: Server, req: Request, res: Response) {
    const { path: filePath, draftID, ignoreWarnings } = req.body;

    await handleErrors.bind(this)(req, res, async () => {
        const { lease } = req;
        const app = lease.app;

        await this.openFile(app, this.normalizePath(filePath));

        let keystrokes: string;
        let deleteDraft = false;

        if (!draftID) {
            throw new SafeError('Missing draft ID');
        }

        const draft = lease.drafts.get(draftID);
        if (draft && draft.path == filePath) {
            for (let dependency of draft.dependsOn) {
                if (lease.drafts.has(dependency)) {
                    throw new SafeError(
                        `Draft ${draftID} depends on draft ${dependency} which has not been applied`
                    );
                }
            }
            keystrokes = draft.keystrokes;
            deleteDraft = true;
        } else {
            throw new SafeError('Invalid draft ID');
        }

        if (draft.hasProblem && !ignoreWarnings) {
            throw new SafeError(
                'Draft has warnings - use ignoreWarnings to ignore them if they are incorrect'
            );
        }

        await app.fsproxy.type(keystrokes);

        // Save the file
        await dispatchKeys(app, ':w\n');

        // Lang server runs on the host (not us) and takes a bit of time to find errors;
        // until then the diagnostic check misses new errors that are typed by the guest.
        // A few seconds delay is OK because our code has been typed out at this point.
        //TODO: fulfill the promise as soon as diagnostics have changed?
        //await new Promise((resolve) => setTimeout(resolve, 5000));

        //TODO: Get diagnostic errors found by the language server
        //const uri = { scheme: 'file', path: filePath } as Uri;
        //const diagnostics = await app.fsproxy.getDiagnostics(uri, 0); // 0 is Error

        // Successful response - no content
        res.send();

        if (deleteDraft) {
            lease.drafts.delete(draftID);
        }
    });
}

type OperationType = 'insert' | 'replace' | 'deleteLines';

export function getKeystrokes(
    operations: { op: OperationType; order: number; params: any }[],
    fileContent: string
) {
    // Always start at the beginning of the file
    let keystrokes = 'gg';

    const sortedOperations = operations.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (let { op, params } of sortedOperations) {
        if (
            op != 'deleteLines' &&
            (params.deleteStartText !== undefined || params.deleteEndText !== undefined)
        ) {
            throw new SafeError('deleteStartText and deleteEndText are only valid for deleteLines');
        }

        // Handle params containing <Esc> or <End>
        for (const value of Object.values(params)) {
            if (typeof value === 'string' && (value.includes('<Esc>') || value.includes('<End>'))) {
                throw new SafeError('Parameters may not contain <Esc> or <End>');
            }
        }

        switch (op) {
            case 'insert': {
                let { anchorText, newCode, indentSpaces = 0, relativePosition } = params;

                // Indent all but the first line
                newCode = indent(newCode, indentSpaces);

                // Also indent the first line, if inserting on a new line
                if (relativePosition == 'linesAfter' || relativePosition == 'linesBefore') {
                    if (indentSpaces > 0) {
                        newCode = ' '.repeat(indentSpaces) + newCode;
                    } else if (indentSpaces < 0) {
                        //TODO: only remove spaces
                        newCode = newCode.slice(-indentSpaces);
                    }
                }

                // Search for anchorText and add newCode in the specified position
                switch (relativePosition) {
                    case 'after':
                        if (anchorText) {
                            keystrokes += '/' + escapeString(anchorText) + '/e\n';
                        }
                        keystrokes += 'a' + newCode + '<Esc>';
                        break;

                    case 'before':
                        if (anchorText) {
                            keystrokes += '/' + escapeString(anchorText) + '\n';
                        }
                        keystrokes += 'i' + newCode + '<Esc>';
                        break;

                    case 'linesAfter':
                        if (anchorText) {
                            keystrokes += '/' + escapeString(anchorText) + '/e\n';
                        }
                        // Exit and re-enter insert mode to avoid auto-indentation
                        keystrokes += 'o<Esc>i' + newCode + '<Esc>';
                        break;

                    case 'linesBefore':
                        if (anchorText) {
                            keystrokes += '/' + escapeString(anchorText) + '\n';
                        }
                        keystrokes += 'O<Esc>i' + newCode + '<Esc>';
                        break;
                }

                break;
            }

            case 'replace': {
                let { anchorText, newCode, indentSpaces = 0 } = params;

                // Indent all but the first line
                newCode = indent(newCode, indentSpaces);

                // Search for anchorText and replace it with newCode.
                // We avoid the traditional :s/old/new/ and instead type newCode in insert mode
                if (anchorText) {
                    keystrokes += '/' + escapeString(anchorText) + '\n';
                }

                // Deleting characters over multiple lines is tricky, so we do it in steps:
                // Delete complete lines (all but the last line).
                const deleteLines = anchorText.match(/\n/g)?.length;
                if (deleteLines) {
                    keystrokes += deleteLines.toString() + 'dd0';
                }

                // Delete the remaining characters.
                const lastNewline = anchorText.lastIndexOf('\n');
                let indentation = '';
                if (lastNewline != -1) {
                    const deleteChars = anchorText.length - lastNewline - 1;
                    if (deleteChars) {
                        keystrokes += deleteChars.toString() + 'x';
                    }
                    const anchorIndex = fileContent.indexOf(anchorText);
                    indentation = fileContent.slice(0, anchorIndex).match(/[^\S\n]*$/)?.[0] ?? '';
                } else {
                    keystrokes += anchorText.length.toString() + 'x';
                }

                // Finally, insert newCode
                keystrokes += 'a' + indentation + newCode + '<Esc>';
                break;
            }

            case 'deleteLines': {
                const { deleteStartText, deleteEndText } = params;
                keystrokes +=
                    '/' + escapeString(deleteStartText) + '\n0:.,/' + escapeString(deleteEndText) + '/d\n';
                break;
            }

            default:
                throw new SafeError(`Unsupported operation ${op}`);
        }
    }

    return keystrokes;
}

export function indent(text: string, level: number) {
    if (level > 0) {
        // Indent all lines except the first one
        text = text.replace(/\n/g, '\n' + ' '.repeat(level));
    } else if (level < 0) {
        // Remove indentation from all lines except the first one
        text = text.replace(new RegExp('\n' + ' '.repeat(-level), 'g'), '\n');
    }

    // After a newline, exit and then re-enter insert mode. This removes
    // indentation added automatically by the editor.
    text = text.replace(/\n/g, '\n<Esc>i');

    return text;
}
