import os from 'os';
import path from 'path';
import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import audit from 'express-requests-logger';
import timeout from 'connect-timeout';
import Sentry from '@sentry/node';
import EventEmitter from 'events';
import { mkdtemp, rm } from 'fs/promises';
import { Server as HttpServer } from 'http';
import { ApplicationOptions, Quality } from 'vscode-automation';
import type { Uri } from 'vscode';
import type { Request } from 'express';

import { ApplicationPool, PooledApplication } from './applicationPool';
import { LiveShare } from './liveshare';
import { ExtensionClient, FileType } from './filesystem';
import { SafeError } from './errors';
import { Logger, noop as noopLogger } from './logger';

import createHandler from './handlers/createDraft';
import applyHandler from './handlers/edit';
import getDiagnostics from './handlers/getDiagnostics';
import { read as readHandler, explore as exploreHandler } from './handlers/read';

export class Draft {
    path: string;
    keystrokes: string;
    dependsOn: string[];
    hasProblem: boolean;
}

export class Lease {
    id: string;
    liveShareUrl: string;
    app: PooledApplication;
    timer: NodeJS.Timeout;
    drafts: Map<string, Draft>;
    readHistory: string[];
    cacheDir: string;
    access: 'none' | 'read' | 'write' = 'none';

    static historyLimit = 4;
    static id = 0;

    constructor(liveShareUrl: string, app: PooledApplication, timer: NodeJS.Timeout, cacheDir: string) {
        this.liveShareUrl = liveShareUrl;
        this.app = app;
        this.timer = timer;
        this.drafts = new Map();
        this.readHistory = [];
        this.id = `${++Lease.id}`;
        this.cacheDir = cacheDir;
    }

    addToReadHistory(path: string) {
        this.readHistory.push(path);
        this.readHistory = this.readHistory.slice(this.readHistory.length - Lease.historyLimit);
    }
}

export class ServerOptions {
    port: number;
    codePath: string;
    appLogger?: Logger;
}

interface StorageClient {
    getUserValue(requestParameters: { user: string; key: string }): Promise<string>;
    putUserValue(requestParameters: { user: string; key: string; body: string; ttl?: number }): Promise<void>;
    deleteUserValue(requestParameters: { user: string; key: string }): Promise<void>;
}

class MemoryStorage {
    private _data = new Map<string, { value: string; expiresAt: number; timer: NodeJS.Timer }>();

    async getUserValue({ user, key }: { user: string; key: string }) {
        return this._data.get(`${user}:${key}`)?.value;
    }

    async putUserValue({
        user,
        key,
        body: value,
        ttl,
    }: {
        user: string;
        key: string;
        body: string;
        ttl: number;
    }) {
        const namespacedKey = `${user}:${key}`;
        const ttlMillis = ttl * 1000;
        const expiresAt = Date.now() + ttlMillis;
        const timer = setTimeout(() => {
            if (this._data.get(namespacedKey)?.expiresAt <= Date.now()) {
                this._data.delete(namespacedKey);
            }
        }, ttlMillis);
        this._data.set(namespacedKey, { value, expiresAt, timer });
    }

    async deleteUserValue({ user, key }: { user: string; key: string }) {
        this._data.delete(`${user}:${key}`);
    }
}

export class Server extends EventEmitter {
    appOptions: ApplicationOptions;
    logger: Logger;
    storage: StorageClient = new MemoryStorage();

    readonly _pool: ApplicationPool;
    readonly _leases: Map<string, Lease>;
    readonly _extensionsPathMap: Map<string, PooledApplication>;

    _httpServer?: HttpServer;

    constructor(logger: Logger = noopLogger) {
        super();
        this.logger = logger;

        this._pool = new ApplicationPool(logger.child({ source: 'ApplicationPool' }));
        this._leases = new Map();
        this._extensionsPathMap = new Map();
    }

    protected joinLiveShare(lease: Lease, url: string, name: string = 'AI', timeout = 30000) {
        const liveShare = new LiveShare(lease.app);
        const timeoutMessage =
            'Timed out waiting for read/write access. You must select "Accept read-only" when ' +
            'the bot initially joins the session, then right-click on the bot in the Live ' +
            'Share explorer and select "Make Read/Write". Due to a Live Share bug, this option ' +
            'will not appear if "Accept read/write" was initially selected.';

        return new Promise(async (resolve, reject) => {
            // Create a timeout that rejects if the bot doesn't join or get promoted to
            // read/write access within the specified interval. It's important to have
            // a strict timeout covering both of these steps because ChatGPT imposes its
            // own timeout on the entire request and will return a generic error message
            // if that's exceeded.
            const timer = setTimeout(() => reject(new SafeError(timeoutMessage)), timeout);

            try {
                // Access is initially set to 'none' when the lease is created,
                // indicating that the bot has not yet joined the session
                if (lease.access === 'none') {
                    await liveShare.join(name, url);
                    lease.access = 'read';
                }

                // Wait for the bot to be promoted
                await liveShare.waitForReadWriteAccess();
                lease.access = 'write';

                resolve(null);
            } catch (error) {
                reject(error);
            } finally {
                clearTimeout(timer);
            }
        });
    }

    protected normalizePath(path: string) {
        // Add leading slash, unless it's a Windows path
        if (!path.startsWith('/') && !path.match(/^[A-Za-z]:/)) {
            path = '/' + path;
        }
        return path;
    }

    protected async openFile(app: PooledApplication, path: string) {
        const uri = { scheme: 'file', path } as Uri;

        try {
            if ((await app.fsproxy?.stat(uri)).type != FileType.File) {
                throw new SafeError({ message: `${path} is not a file`, sensitive: true });
            }
        } catch (error) {
            throw new SafeError({
                message: `Failed to read ${path}. Check the path and try again.`,
                cause: error,
                sensitive: true,
            });
        }

        await app.workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
        await app.fsproxy.openFile(uri);
    }

    async start(options: ServerOptions) {
        this.appOptions = Object.assign(
            {
                codePath: options.codePath,
                logger: options.appLogger ?? noopLogger,
                quality: Quality.Dev,
            },
            this.appOptions
        );

        const server = expressWs(express()).app;

        // List of sensitive headers to redact in logs
        let sensitiveHeaders = ['authorization'];
        sensitiveHeaders.push(...sensitiveHeaders.map((x) => x[0].toUpperCase() + x.slice(1)));

        // List of sensitive request parameters to redact in logs
        const sensitiveRequestParams = [
            'liveShareUrl',
            'path',
            'anchorText',
            'newCode',
            'deleteStartText',
            'deleteEndText',
        ];

        // Initialize Sentry
        Sentry.init({
            dsn: 'https://f0d3b11e3787a8ef26935c97931c9fad@o4505863653228544.ingest.sentry.io/4505897260875776',
            environment: process.env.NODE_ENV ?? 'development',
            tracesSampleRate: 1.0,
            integrations: [
                new Sentry.Integrations.Http({ tracing: true }),
                new Sentry.Integrations.Express({ app: server }),
            ],
            beforeSend(event) {
                for (const key in sensitiveHeaders) {
                    if (event.request.headers[key]) {
                        event.request.headers[key] = '<redacted>';
                    }
                }
                for (const key in sensitiveRequestParams) {
                    if (event.request.data[key]) {
                        event.request.data[key] = '<redacted>';
                    }
                }
                return event;
            },
        });

        // Disable the X-Powered-By header
        server.disable('x-powered-by');

        // Trust the X-Forwarded-For header from Cloudflare
        server.set(
            'trust proxy',
            'loopback, 2400:cb00::/32, 2606:4700::/32, 2803:f800::/32, 2405:b500::/32, 2405:8100::/32, 2a06:98c0::/29, 2c0f:f248::/32'
        );

        // Install Sentry middleware (must be first)
        server.use(Sentry.Handlers.requestHandler(), Sentry.Handlers.tracingHandler());

        // Set a timeout matching the ChatGPT request timeout
        server.use(timeout('45s', { respond: false }));
        server.use((req, res, next) => {
            req.addListener('timeout', () => {
                // Exclude internal WebSocket connections (which are long-lived)
                if (!req.path.startsWith('/fsproxy')) {
                    Sentry.captureEvent({ message: 'Request timed out' });
                }
            });
            next();
        });

        // Middleware for parsing JSON request bodies
        server.use(express.json());

        // Log requests (with sensitive data masked)
        server.use(
            audit({
                logger: this.logger.child({ source: 'express' }),
                request: {
                    maskBody: sensitiveRequestParams,
                    maskHeaders: sensitiveHeaders,
                },
                response: {
                    // I think this is the only way to avoid logging response bodies:
                    maxBodyLength: 1,
                },
                doubleAudit: true,
            })
        );

        // Allow CORS requests from ChatGPT (note that this is only relevant
        // for local development, because prod requests are proxied)
        server.use(
            cors({
                origin: 'https://chat.openai.com',
            })
        );

        // Serve static assets
        server.use(express.static(path.join('public', process.env.NODE_ENV ?? 'development')));

        // Set up API endpoint handlers
        server.post('/explore', exploreHandler.bind(this));
        server.post('/read', readHandler.bind(this));
        server.post('/edit/create', createHandler.bind(this));
        server.post('/edit/apply', applyHandler.bind(this));
        server.post('/diagnostics', getDiagnostics.bind(this));

        // The extension connects back via WebSocket when activated
        server.ws('/fsproxy', async (ws, req) => {
            if (req.socket.remoteAddress !== req.socket.localAddress) {
                this.logger.error('Rejecting WebSocket connection', { ip: req.socket.remoteAddress });
                ws.close();
                return;
            }

            ws.on('message', async (raw: string) => {
                const message = JSON.parse(raw);

                // Extension sends 'hello' message when VSLS workspace is opened
                if (message.command == 'hello') {
                    const extensionsPath = path.dirname(message.params.extensionPath);
                    const app = this._extensionsPathMap.get(extensionsPath);
                    if (!app) {
                        this.logger.error('Got fsproxy hello message with unknown extension path', {
                            message,
                        });
                        return;
                    }

                    // Create an ExtensionClient and have the PooledApplication hold a reference to it
                    app.fsproxy = new ExtensionClient(ws, this.logger.child({ source: 'ExtensionClient' }));
                    app.markAsReady();

                    // When the connection is closed, remove the proxy
                    ws.on('close', () => {
                        this.logger.info(`Client went away, extensionsPath: ${extensionsPath}`);
                    });
                } else if (message.command) {
                    this.logger.error('Got fsproxy message with unknown command', { message });
                }
            });
        });

        server.get('/info', (req, res) => {
            res.send('Only Live Share is currently supported. No further info is available.');
        });

        this._httpServer = server.listen(options.port, () => {
            this.logger.info(`Listening on port ${options.port}`);
        });
    }

    async stop() {
        this.emit('stopping');
        await new Promise((resolve) => this._httpServer.close(resolve));
        await this._pool.dispose();
        this.emit('stopped');
    }

    async getOrCreateLease(req: Request, liveShareUrl?: string, ttlSeconds?: number, mustUsePool?: boolean) {
        if (
            !liveShareUrl ||
            (!liveShareUrl.startsWith('https://prod.liveshare.vsengsaas.visualstudio.com/join?') &&
                !liveShareUrl.startsWith('https://vscode.dev/liveshare/')) ||
            !/[0-9A-F]{36}$/.test(liveShareUrl)
        ) {
            throw new SafeError(
                'Invalid or unsupported Live Share URL. Please start a new Live Share session and try again.'
            );
        }

        let lease = this._leases.get(liveShareUrl);
        if (lease) {
            // Reset the timer for the liveShareUrl
            clearTimeout(lease.timer);
            lease.timer = this._createTimeout(liveShareUrl, lease.app, ttlSeconds);
        } else {
            req.logger?.debug('Acquiring lease');

            const app = await this._pool.acquire(this.appOptions, mustUsePool);
            const timer = this._createTimeout(liveShareUrl, app, ttlSeconds);
            const cacheDir = await mkdtemp(os.tmpdir() + path.sep + 'lease-');

            lease = new Lease(liveShareUrl, app, timer, cacheDir);
            this._leases.set(liveShareUrl, lease);
            this._extensionsPathMap.set(app.extensionsPath, app);
        }

        if (lease.access !== 'write') {
            await this.joinLiveShare(lease, liveShareUrl);
            req.logger?.info('Got read/write access', { extensions_path: lease.app.extensionsPath });
            await lease.app.ready;
            req.logger?.debug('App is ready');
        }

        return lease;
    }

    finalizeLease(lease?: Lease) {
        if (lease) {
            this._leases.delete(lease.liveShareUrl);
            this._extensionsPathMap.delete(lease.app.extensionsPath);
            this._pool.release(lease.app);
            return rm(lease.cacheDir, { recursive: true, force: true });
        }
    }

    private _createTimeout(liveShareUrl: string, app: PooledApplication, seconds = 900): NodeJS.Timeout {
        const generationAtTimerCreation = app.generation;
        return setTimeout(() => {
            const lease = this._leases.get(liveShareUrl);
            if (app == lease?.app && generationAtTimerCreation == lease?.app.generation) {
                this.finalizeLease(lease);
            }
        }, seconds * 1000);
    }
}

export function defaultCodePath() {
    switch (os.platform()) {
        case 'darwin':
            return '/Applications/Visual Studio Code.app';
        default:
            return '/usr/share/code';
    }
}
