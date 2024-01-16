import fs from 'fs';
import opentelemetry from '@opentelemetry/api';
import type { DiagnosticSeverity, FileStat, FileSystem, TextDocument, Uri } from 'vscode';
import type { WebSocket } from 'ws';
import { SafeError } from './errors';
import { Logger, noop as noopLogger } from './logger';

// Add all metrics here:
const meter = opentelemetry.metrics.getMeter('filesystem');
const commandCounter = meter.createCounter('sfd.filesystem.commands_sent_total');
const timeoutCounter = meter.createCounter('sfd.filesystem.commands_timed_out_total');
const successCounter = meter.createCounter('sfd.filesystem.commands_succeeded_total');
const failureCounter = meter.createCounter('sfd.filesystem.commands_failed_total');

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
}

export type ReadableFileSystem = Pick<FileSystem, 'stat' | 'readDirectory' | 'readFile'>;

export type WritableFileSystem = Pick<FileSystem, 'createDirectory' | 'writeFile'>;

export class NodeFileSystem implements ReadableFileSystem {
    stat(uri: Uri): Promise<FileStat> {
        return new Promise((resolve, reject) => {
            fs.stat(uri.path, (err, stats) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        type: stats.isDirectory() ? FileType.Directory : FileType.File,
                        ctime: stats.ctimeMs,
                        mtime: stats.mtimeMs,
                        size: stats.size,
                    });
                }
            });
        });
    }

    readDirectory(uri: Uri): Promise<[string, FileType][]> {
        return new Promise((resolve, reject) => {
            fs.readdir(uri.path, { withFileTypes: true }, (err, dirents) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(
                        dirents.map((dirent) => [
                            dirent.name,
                            dirent.isDirectory()
                                ? FileType.Directory
                                : dirent.isFile()
                                ? FileType.File
                                : FileType.Unknown,
                        ])
                    );
                }
            });
        });
    }

    readFile(uri: Uri): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            fs.readFile(uri.path, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }
}

interface ExtensionResponse {
    id: string;
    result?: any;
    error?: any;
}

export class ExtensionClient implements ReadableFileSystem, WritableFileSystem {
    readonly logger: Logger;

    private _ws: WebSocket;
    private _requestMap: Map<
        string,
        { command: string; resolve: (value: any) => void; reject: (error: any) => void }
    >;
    private _nextID = 1;
    private _timeoutMillis = 30000;

    constructor(ws: WebSocket, logger: Logger = noopLogger) {
        this.logger = logger;
        this._ws = ws;
        this._requestMap = new Map();

        this._ws.on('message', (message: string) => {
            const response: ExtensionResponse = JSON.parse(message);
            logger.debug('ExtensionClient: received response', { id: response.id });

            if (this._requestMap.has(response.id)) {
                const { command, resolve, reject } = this._requestMap.get(response.id);
                if (response.error) {
                    logger.debug('ExtensionClient: rejecting request', { id: response.id });
                    reject(response.error);
                    failureCounter.add(1, { command });
                } else {
                    logger.debug('ExtensionClient: resolving request', { id: response.id });
                    resolve(response.result);
                    successCounter.add(1, { command });
                }
                this._requestMap.delete(response.id);
            }
        });
    }

    get alive() {
        return this._ws.readyState === this._ws.OPEN || this._ws.readyState === this._ws.CONNECTING;
    }

    async sendCommand(command: string, params = {}): Promise<any> {
        if (!this.alive) {
            throw new Error('ExtensionClient: connection is not alive');
        }

        // Generate a unique ID for this request
        const id = (this._nextID++).toString();

        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({ id, command, params });
            this.logger.debug('ExtensionClient: sending message', { id, command });
            this._requestMap.set(id, { command, resolve, reject });
            this._ws.send(payload);

            // If the extension doesn't respond, reject the promise
            setTimeout(() => {
                if (this._requestMap.has(id)) {
                    this._requestMap.delete(id);
                    reject(
                        new Error(
                            `Extension did not respond to '${command}' command within ${this._timeoutMillis}ms`
                        )
                    );
                    timeoutCounter.add(1, { command });
                }
            }, this._timeoutMillis);

            commandCounter.add(1, { command });
        });
    }

    async stat(uri: Uri): Promise<FileStat> {
        try {
            return await this.sendCommand('stat', { path: uri.path });
        } catch (error) {
            let message = 'File not found';
            let sensitive = false;
            let existingPaths = await this.findValidPaths(uri.path, 3);
            if (existingPaths.length > 0) {
                message += `. Did you mean: ${existingPaths.join(', ')}`;
                sensitive = true;
            }
            throw new SafeError({ message, cause: error, sensitive });
        }
    }

    async findValidPaths(path: string, maxPaths: number): Promise<string[]> {
        let existingPaths = [];
        while (path && existingPaths.length < maxPaths) {
            try {
                await this.sendCommand('stat', { path });
                existingPaths.push(path);
            } catch (error) {
                // Ignore the error and continue with the loop
            }
            // Remove the first path component
            let pathComponents = path.split(/[\/\\]/);
            pathComponents.shift();
            path = pathComponents.join('/');
        }
        return existingPaths;
    }

    async readDirectory(uri: Uri): Promise<[string, FileType][]> {
        return this.sendCommand('readDirectory', { path: uri.path });
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
        const text = await this.sendCommand('readFile', { path: uri.path });
        return new TextEncoder().encode(text);
    }

    async openFile(uri: Uri): Promise<void> {
        return this.sendCommand('openFile', { path: uri.path });
    }

    async getDiagnostics(uri: Uri, severity?: DiagnosticSeverity): Promise<any[]> {
        return this.sendCommand('getDiagnostics', { path: uri.path, severity });
    }

    async type(text: String) {
        return this.sendCommand('type', { text });
    }

    async getEditorText(): Promise<string> {
        return this.sendCommand('getEditorText');
    }

    async createDirectory(uri: Uri): Promise<void> {
        return this.sendCommand('createDirectory', { path: uri.path });
    }

    async createIntermediateDirectories(uri: Uri): Promise<void> {
        let pathComponents = uri.path.split('/');
        pathComponents.pop();
        let path = '';
        for (let pathComponent of pathComponents) {
            if (pathComponent.length) {
                path += '/' + pathComponent;
                try {
                    await this.stat({ scheme: 'file', path } as Uri);
                } catch (error) {
                    await this.createDirectory({ scheme: 'file', path } as Uri);
                }
            }
        }
    }

    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
        await this.createIntermediateDirectories(uri);
        return this.sendCommand('writeFile', {
            path: uri.path,
            content: new TextDecoder().decode(content),
        });
    }
}
