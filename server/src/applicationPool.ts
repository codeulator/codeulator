import os from 'os';
import path from 'path';
import EventEmitter from 'events';
import opentelemetry from '@opentelemetry/api';
import { fileURLToPath } from 'url';
import { readFile, writeFile, mkdtemp, mkdir } from 'fs/promises';
import { Application, ApplicationOptions } from 'vscode-automation';

import { Logger, noop as noopLogger } from './logger';
import { installExtension } from './extensions';
import { ExtensionClient } from './filesystem';
import { SafeError } from './errors';

// Add all metrics here:
const meter = opentelemetry.metrics.getMeter('app_pool');
const poolSizeGauge = meter.createObservableGauge('sfd.app_pool.pool_size');
const disposedCounter = meter.createCounter('sfd.app_pool.disposed_total');
const releasedCounter = meter.createCounter('sfd.app_pool.released_total');
const acquiredCounter = meter.createCounter('sfd.app_pool.acquired_total');
const queuedOpsGauge = meter.createObservableGauge('sfd.app_pool.queued_ops');
const activeOpsGauge = meter.createObservableGauge('sfd.app_pool.active_ops');
const memFreeGauge = meter.createObservableGauge('sfd.app_pool.mem_free_bytes');
const memTotalGauge = meter.createObservableGauge('sfd.app_pool.mem_total_bytes');

meter.addBatchObservableCallback(
    (observableResult) => {
        // Sizes are in kB, but we need to report bytes
        observableResult.observe(memFreeGauge, ApplicationPool.memInfo.MemFree * 1024);
        observableResult.observe(memTotalGauge, ApplicationPool.memInfo.MemTotal * 1024);

        observableResult.observe(queuedOpsGauge, PooledApplication.queuedOperations);
        observableResult.observe(activeOpsGauge, PooledApplication.activeOperations);
    },
    [memFreeGauge, memTotalGauge, queuedOpsGauge, activeOpsGauge]
);

export class PooledApplication extends Application {
    ready: Promise<void>;
    markAsReady: () => void;
    fsproxy?: ExtensionClient;
    generation = 1;
    lock = Promise.resolve();

    static queuedOperations = 0;
    static activeOperations = 0;

    constructor(options: ApplicationOptions) {
        super(options);
        this.resetExtensionState();
    }

    resetExtensionState() {
        this.ready = new Promise((resolve) => {
            this.markAsReady = resolve;
        });
        this.fsproxy = null;
    }

    restart(options?: { workspaceOrFolder?: string; extraArgs?: string[] }): Promise<void> {
        this.resetExtensionState();
        this.generation++;
        return super.restart(options);
    }

    async performOperation(fn: () => Promise<void>) {
        PooledApplication.queuedOperations++;

        // Wrap the operation to only run if the generation hasn't changed
        let generationWhenQueued = this.generation;
        const wrappedFn = async () => {
            PooledApplication.queuedOperations--;

            if (this.generation === generationWhenQueued) {
                PooledApplication.activeOperations++;

                // Catch errors to avoid breaking the chain
                let result: any;
                try {
                    result = await fn();
                } catch (error) {
                    result = error;
                }

                PooledApplication.activeOperations--;
                return result;
            }
        };

        // Update the lock to wait for the previous operation, then perform this one
        let lock = this.lock;
        lock = lock.then(wrappedFn);

        // Store the updated lock
        this.lock = lock;

        // Wait for this operation to complete
        const result: any = await lock;
        if (result instanceof Error) {
            throw result;
        }
    }
}

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const defaultExtensions = [
    path.join(dirname, 'ms-vsliveshare.vsliveshare-1.0.5877.vsix'),
    path.join(dirname, 'vscodevim.vim-1.25.2.vsix'),
    path.join(dirname, 'fsproxy-0.0.1.vsix'),
];

export class ApplicationPool extends EventEmitter {
    readonly logger: Logger;
    private readonly _pool: PooledApplication[] = [];
    private _extensions: string[];
    private _maxPoolSize: number;
    private _memoryPressureTimer: NodeJS.Timer | undefined;

    oom = false;

    static memInfo?: { [key: string]: number };

    constructor(
        logger: Logger = noopLogger,
        maxPoolSize = parseInt(process.env.SFD_POOL_SIZE) || 3,
        extensions = defaultExtensions,
        monitorMemoryPressure = process.env.NODE_ENV === 'production'
    ) {
        super();
        this.logger = logger;
        this._extensions = extensions;
        this._maxPoolSize = maxPoolSize;
        logger.info('Application pool initialized', { max_size: maxPoolSize, extensions });

        if (monitorMemoryPressure) {
            if (os.platform() === 'linux') {
                this._monitorMemoryPressure();
            } else {
                logger.error('Memory pressure monitoring is only supported on Linux');
            }
        }

        meter.addBatchObservableCallback(
            (observerResult) => {
                observerResult.observe(poolSizeGauge, this._pool.length);
            },
            [poolSizeGauge]
        );
    }

    async acquire(
        partialOptions: Pick<ApplicationOptions, 'codePath' | 'logger' | 'quality'> &
            Partial<ApplicationOptions>,
        mustUsePool?: boolean
    ): Promise<PooledApplication> {
        if (this._pool.length > 0) {
            acquiredCounter.add(1, { pool: true });
            return this._pool.pop();
        } else if (mustUsePool) {
            throw new Error('Pool is empty but mustUsePool is set');
        }

        if (this.oom) {
            throw new SafeError('The service is at capacity. Please try again later.', 429);
        }

        const basePath = await mkdtemp(os.tmpdir() + path.sep);
        const options: ApplicationOptions = Object.assign(
            {
                workspacePath: path.join(basePath, 'workspace'),
                userDataDir: path.join(basePath, 'userdata'),
                extensionsPath: path.join(basePath, 'extensions'),
                logsPath: path.join(basePath, 'logs'),
                crashesPath: path.join(basePath, 'crashes'),
                // Disable git extension (it interferes with waitForJoinAsAnonymous)
                extraArgs: ['--disable-extension', 'vscode.git'],
            },
            partialOptions
        );

        for (const dir of [
            options.workspacePath,
            path.join(options.userDataDir, 'User'),
            options.extensionsPath,
        ]) {
            await mkdir(dir, { recursive: true });
        }

        // Disable auto-closing brackets and quotes
        await writeFile(
            path.join(options.userDataDir, 'User', 'settings.json'),
            JSON.stringify({
                'editor.autoClosingBrackets': 'never',
                'editor.autoClosingQuotes': 'never',
                'editor.autoIndent': 'none',
            })
        );

        for (const id of this._extensions) {
            this.logger.debug('Installing extension', { id });
            await installExtension(id, options);
        }

        const app = new PooledApplication(options);
        await app.start();
        acquiredCounter.add(1, { pool: false });
        return app;
    }

    async release(app: PooledApplication) {
        const logger = this.logger.child({
            extensions_path: app.extensionsPath,
            generation: app.generation,
        });

        let action: 'stop' | 'restart';
        if (this._pool.length < this._maxPoolSize) {
            action = 'restart';
        } else {
            action = 'stop';
        }

        try {
            switch (action) {
                case 'stop':
                    app.performOperation(() => app.stop());
                    break;

                case 'restart':
                    app.performOperation(() => app.restart()).then(() => {
                        this._pool.push(app);
                    });
                    break;
            }

            logger.debug('Released app', { action });
            releasedCounter.add(1, { action });
        } catch (error) {
            logger.error(`Failed to ${action} app`, { error });
        }
    }

    async dispose() {
        await Promise.all(this._pool.map((app) => app.stop()));
        if (this._memoryPressureTimer) {
            clearInterval(this._memoryPressureTimer);
        }
    }

    private async _monitorMemoryPressure() {
        const threshold = 0.25; // Customize the memory pressure threshold as needed

        this._memoryPressureTimer = setInterval(async () => {
            await ApplicationPool._readMeminfo();
            const memFree = ApplicationPool.memInfo.MemFree;
            const memTotal = ApplicationPool.memInfo.MemTotal;

            this.oom = false;
            if (memFree / memTotal < threshold) {
                const disposed = await this._disposeBatch();
                this.logger.info('Jettisoned some apps due to memory pressure', {
                    disposed,
                    memFree,
                    memTotal,
                    threshold,
                });
                if (disposed == 0) {
                    // Unable to dispose any apps
                    this.emit('oom', { memFree, memTotal });
                    this.oom = true;
                } else {
                    this.emit('disposed', { memFree, memTotal, disposed });
                }
            }
        }, 10000); // Customize the interval as needed
    }

    private async _disposeBatch() {
        const batchSize = Math.ceil(this._pool.length * 0.25); // Customize the batch size as needed
        const appsToDispose = this._pool.splice(-batchSize, batchSize);
        await Promise.all(appsToDispose.map((app) => app.stop()));
        disposedCounter.add(appsToDispose.length);
        return appsToDispose.length;
    }

    private static async _readMeminfo(): Promise<void> {
        const data = await readFile('/proc/meminfo', 'utf8');
        const lines = data.split('\n');
        const result: { [key: string]: number } = {};

        for (const line of lines) {
            const [key, value] = line.split(':');
            if (value) {
                result[key.trim()] = parseInt(value.trim().split(' ')[0], 10);
            }
        }

        ApplicationPool.memInfo = result;
    }
}
