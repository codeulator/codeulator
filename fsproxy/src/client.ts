import {
    commands,
    env,
    languages,
    window,
    FileSystem,
    Uri,
    Range,
    WorkspaceEdit,
    WorkspaceEditMetadata,
    workspace,
} from 'vscode';

import { WebSocket } from 'ws';
import { TextEncoder } from 'util';

type ApplyEdit = (edit: WorkspaceEdit, metadata?: WorkspaceEditMetadata) => Thenable<boolean>;

export class ClientOptions {
    fs: FileSystem;
    applyEdit: ApplyEdit;
    extensionPath: string;
    webSocketURL: string;
}

// Client is so named because the extension connects back to the server
export class Client {
    private _fs: FileSystem;
    private _conn: WebSocket | null = null;
    private _applyEdit: ApplyEdit;

    private _logBuffer = '';
    private _flushLogBuffer = debounce(() => {
        if (this._logBuffer.length) {
            console.debug(
                'ExtensionClient: cursor now at %d:%d',
                window.activeTextEditor?.selection.active.line,
                window.activeTextEditor?.selection.active.character
            );
            this._logBuffer = '';
        }
    }, 1000);

    async start(options: ClientOptions) {
        return new Promise<void>((resolve, reject) => {
            this._fs = options.fs;
            this._conn = new WebSocket(options.webSocketURL);
            this._applyEdit = options.applyEdit;

            this._conn.on('open', () => {
                // Send hello message when connected
                this._conn?.send(
                    JSON.stringify({
                        id: Date.now(),
                        command: 'hello',
                        params: {
                            appRoot: env.appRoot,
                            extensionPath: options.extensionPath,
                        },
                    })
                );

                resolve();
            });

            this._conn.on('message', async (message) => {
                const { id, command, params } = JSON.parse(message.toString());
                let result = null;

                if (
                    [
                        'stat',
                        'readDirectory',
                        'readFile',
                        'createDirectory',
                        'writeFile',
                        'openFile',
                        'getDiagnostics',
                    ].includes(command)
                ) {
                    // Add leading slash, unless it's a Windows path
                    let { path: filePath } = params;
                    if (!filePath.startsWith('/') && !filePath.match(/^[A-Za-z]:/)) {
                        filePath = '/' + filePath;
                    }

                    console.debug('ExtensionClient: %s', command);
                    const uri = Uri.from({ scheme: 'vsls', path: filePath });

                    if (command === 'getDiagnostics') {
                        const { severity } = params;
                        result = languages
                            .getDiagnostics(uri)
                            .filter((diag) => severity === undefined || diag.severity === severity)
                            .map((diag) => {
                                return {
                                    start: `${diag.range.start.line}:${diag.range.start.character}`,
                                    end: `${diag.range.end.line}:${diag.range.end.character}`,
                                    // Messages are omitted because they tend to confuse ChatGPT
                                };
                            });
                    } else {
                        try {
                            const uriOnlyCommands = [
                                'stat',
                                'readDirectory',
                                'readFile',
                                'createDirectory',
                            ] as const;
                            if (uriOnlyCommands.includes(command)) {
                                result = await this._fs[command as (typeof uriOnlyCommands)[number]](uri);
                            } else if (command === 'writeFile') {
                                const edit = new WorkspaceEdit();
                                edit.createFile(uri, {
                                    overwrite: true,
                                    contents: new TextEncoder().encode(params.content),
                                });
                                result = await this._applyEdit(edit);
                            } else if (command === 'openFile') {
                                await workspace.openTextDocument(uri);
                            }
                        } catch (error) {
                            this._conn?.send(JSON.stringify({ id, error }));
                        }
                        if (result instanceof Uint8Array) {
                            result = result.toString();
                        }
                    }
                } else if (command === 'type') {
                    await this.type(params.text);
                } else if (command === 'getEditorText') {
                    let range: Range | undefined = undefined;
                    const { startLine, startCharacter, endLine, endCharacter } = params;
                    if (
                        startLine !== undefined &&
                        startCharacter !== undefined &&
                        endLine !== undefined &&
                        endCharacter !== undefined
                    ) {
                        range = new Range(startLine, startCharacter, endLine, endCharacter);
                    }
                    result = window.activeTextEditor?.document.getText(range);
                } else {
                    console.log(`Unknown command: ${command}`);
                    return;
                }

                // Send the result back to the server, including the id for tracking
                this._conn?.send(JSON.stringify({ id, result }));
            });

            this._conn.on('error', (err) => {
                reject(err);
            });
        });
    }

    static specialKeys = ['<Esc>', '<End>'];

    async type(text: string, type = (text: string[1]) => commands.executeCommand('type', { text })) {
        const typeSingleKey = async (text: string) => {
            // Don't type more than 1 key every 10ms
            await Promise.all([type(text), new Promise((resolve) => setTimeout(resolve, 10, null))]);
        };

        const normalizeCase = (text: string) => {
            // Only capitalize the first letter after the opening bracket
            return text.replace(/<(.)/, (match, p1) => '<' + p1.toUpperCase());
        };

        const typeKeys = async (keys: string) => {
            for (let key of keys) {
                await typeSingleKey(key);
            }
        };

        // Determine the maximum length of special keys
        const maxKeyLength = Client.specialKeys.reduce((max, key) => Math.max(max, key.length), 0);

        let buffer = '';
        for (let char of text.replace('<Enter>', '\n')) {
            // Always flush on '<' to account for sequences like '<<Esc>'
            if (char === '<') {
                await typeKeys(buffer);
                buffer = '';
            }

            buffer += char;

            // If buffer size exceeds maximum special key length or if it doesn't start with '<',
            // flush out the buffer as normal characters.
            if (buffer.length > maxKeyLength || !buffer.startsWith('<')) {
                await typeKeys(buffer);
                buffer = '';
            } else if (char === '>') {
                const normalized = normalizeCase(buffer);
                if (Client.specialKeys.includes(normalized)) {
                    await typeSingleKey(normalized);
                    buffer = '';
                }
            }
        }

        // Handle any remaining characters in the buffer after the loop
        await typeKeys(buffer);
    }

    async stop() {
        return new Promise<void>((resolve, reject) => {
            if (this._conn) {
                this._conn.on('close', () => {
                    resolve();
                });
                this._conn.on('error', (err) => {
                    reject(err);
                });
                this._conn.close();
                this._conn = null;
            } else {
                resolve();
            }
        });
    }
}

function debounce(func: any, delay: any) {
    let debounceTimer: any;
    return function (this: any) {
        const context = this;
        const args = arguments;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => func.apply(context, args), delay);
    };
}
