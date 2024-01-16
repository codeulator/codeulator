import os from 'os';
import path from 'path';
import assert from 'assert';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { parseArgs } from 'node:util';

import clipboard from 'clipboardy';
import Docker from 'dockerode';
import { Application, ApplicationOptions, Quality } from 'vscode-automation';
import { createPatch } from 'diff';

import { Logger, consoleLogger } from '../logger';
import { defaultCodePath } from '../server';
import { installExtension } from '../extensions';
import { LiveShare } from '../liveshare';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export type TestCase = {
    name: string;
    requests: { url: string; params: object; statusCode: number }[];
    fsBefore: { [filePath: string]: string };
    fsAfter: { [filePath: string]: string };
    iterations?: number;
    mustUsePoolAfterFirstIteration?: boolean;
    pauseMillis?: number;
};

export class TestHarness {
    logger: Logger;
    app?: Application;
    readonly didTeardown: Promise<void>;
    private _setDidTeardown: () => void;
    private _abortController = new AbortController();

    constructor(logger: Logger) {
        this.logger = logger;
        this.didTeardown = new Promise((resolve) => {
            this._setDidTeardown = resolve;
        });
    }

    async runTests(
        testCases: TestCase[],
        {
            doCleanup = true,
            containerLogLevel = 'debug',
            containerLogDestination = process.stderr as NodeJS.WriteStream,
            userDataDir = undefined as string | undefined,
            extensionsPath = undefined as string | undefined,
            codePath = undefined as string | undefined,
        }
    ) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
        this.logger.info('Created staging directory', { path: tempDir });

        const docker = new Docker();
        const container = await docker.createContainer({
            Image: 'sfd',
            Env: ['NODE_ENV=development', `SFD_LOG_LEVEL=${containerLogLevel}`],
            Tty: true,
            AttachStdout: !!containerLogDestination,
            AttachStderr: !!containerLogDestination,
            AttachStdin: false,
            HostConfig: {
                PortBindings: { '3100/tcp': [{ HostIp: '', HostPort: '3100' }] },
            },
        });

        // Pipe container logs
        container.attach({ stream: true, stdout: true, stderr: true }, (err, stream) => {
            if (err) {
                throw err;
            }
            stream.pipe(containerLogDestination);
        });

        await container.start();
        this.logger.info('Started sfd', { container_id: container.id });

        try {
            for (let i = 0; i < testCases.length; i++) {
                const subdir = path.join(tempDir, i.toString());
                fs.mkdirSync(subdir);

                for (let j = 0; j < (testCases[i].iterations || 1); j++) {
                    this.logger.info('Running test iteration', {
                        test_case: { name: testCases[i].name },
                        iteration: j,
                    });
                    await this.runTest(testCases[i], j, subdir, userDataDir, extensionsPath, codePath);
                }
            }
        } finally {
            this.logger.info('Stopping and removing container...');
            await container.stop();
            await container.remove();

            if (doCleanup) {
                this.logger.info('Cleaning up temp files');
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            this._setDidTeardown();
        }
    }

    async runTest(
        testCase: TestCase,
        iteration: number,
        basePath: string,
        userDataDir?: string,
        extensionsPath?: string,
        codePath = defaultCodePath()
    ) {
        this._abortController.signal.throwIfAborted();

        const { fsBefore } = testCase;
        const logger = this.logger.child({ test_case: { name: testCase.name } });

        const options: ApplicationOptions = {
            quality: Quality.Dev,
            logger: logger.child({ source: 'Application' }),
            codePath,
            workspacePath: path.join(basePath, 'workspace'),
            userDataDir: userDataDir || path.join(basePath, 'userdata'),
            extensionsPath: extensionsPath || path.join(basePath, 'extensions'),
            logsPath: path.join(basePath, 'logs'),
            crashesPath: path.join(basePath, 'crashes'),
        };

        for (const dir of [
            options.workspacePath,
            path.join(options.userDataDir, 'User'),
            options.extensionsPath,
        ]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        // Set up initial filesystem state
        for (const [filePath, fileContent] of Object.entries(fsBefore)) {
            const absolutePath = path.join(options.workspacePath, filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, fileContent);
        }

        // Auto-accept Live Share guest requests
        const settingsPath = path.join(options.userDataDir, 'User', 'settings.json');
        if (!fs.existsSync(settingsPath)) {
            fs.writeFileSync(
                settingsPath,
                JSON.stringify({
                    'liveshare.anonymousGuestApproval': 'accept',
                })
            );
        }

        // Install the Live Share extension
        const liveShareVersion = '1.0.5877';
        const extensionPath = path.resolve(
            path.join(dirname, '..', `ms-vsliveshare.vsliveshare-${liveShareVersion}.vsix`)
        );
        if (
            !fs.existsSync(
                path.join(options.extensionsPath, `ms-vsliveshare.vsliveshare-${liveShareVersion}`)
            )
        ) {
            logger.info('Installing extension...', { path: extensionPath });
            await installExtension(extensionPath, options);
        }

        // Start VS Code
        this.app = new Application(options);
        await this.app.start();
        logger.info('Started application');

        // Reinstall our SIGINT handler (Playwright overrides it when starting the app)
        reinstallSignalHandlers();

        try {
            await this._runTestWithApp(this.app, iteration, options, testCase, logger);
        } finally {
            // Shut down VS Code
            if (this.app.code) {
                await this.app.stop();
            }
        }
    }

    private async _runTestWithApp(
        app: Application,
        iteration: number,
        options: ApplicationOptions,
        testCase: TestCase,
        logger: Logger
    ) {
        const { requests, fsAfter } = testCase;

        // Create a Live Share session and wait for it to start
        await app.workbench.quickaccess.runCommand('liveshare.start');
        const liveShare = new LiveShare(app);
        await liveShare.waitForReadWriteAccess();

        // Elevate the bot to read-write access (but don't wait for the promise
        // to resolve, because the bot won't join until a request is made)
        liveShare.elevate('AI').catch((error) => logger.error('Failed to elevate bot', { error }));

        // Perform each request
        for (const request of requests) {
            const response = await fetch(`http://127.0.0.1:3100${request.url}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    ...request.params,
                    liveShareUrl: clipboard.readSync(),
                    mustUsePool: testCase.mustUsePoolAfterFirstIteration && iteration > 0,
                }),
                signal: this._abortController.signal,
            });

            // Verify expected response status code
            const isJson = response.headers.get('content-type') == 'application/json';
            assert.equal(
                response.status,
                request.statusCode,
                (isJson && (await response.json()).error?.message) ?? response.statusText
            );
        }

        // Verify expected filesystem state
        for (const filePath in fsAfter || []) {
            // Save the file
            await openFile(app, filePath);
            await app.workbench.editors.saveOpenedFile();

            // Verify contents
            const fileContent = fs.readFileSync(path.join(options.workspacePath, filePath), 'utf-8');
            if (fileContent != fsAfter[filePath]) {
                let diff = createPatch(filePath, fsAfter[filePath], fileContent);
                assert.fail(`File ${filePath} does not match expected content:\n${diff}`);
            }
        }

        if (testCase.pauseMillis) {
            logger.info(`Pausing for ${testCase.pauseMillis}ms`);
            await new Promise((resolve) => setTimeout(resolve, testCase.pauseMillis));
        }
    }

    async abort() {
        this._abortController.abort();
        if (this.app?.code) {
            await this.app.stop();
        }
        await this.didTeardown;
    }
}

async function openFile(app: Application, filePath: string) {
    let fileName = path.basename(filePath);

    // Remove leading slash (interferes when host)
    if (filePath.length != 0 && filePath[0] == path.sep) {
        filePath = fileName.slice(1);
    }

    // quick access shows files with the basename of the path
    await app.workbench.quickaccess.openFileQuickAccessAndWait(filePath, fileName);

    // open first element
    await app.workbench.quickinput.selectQuickInputElement(0);

    // wait for editor being focused
    await app.workbench.editors.waitForActiveTab(fileName);
    await app.workbench.editors.selectTab(fileName);
}

let {
    values: {
        testCase: testCasePaths,
        keepTempFiles,
        userDataDir,
        extensionsPath,
        codePath,
        logLevel,
        containerLogLevel,
        verbose,
    },
} = parseArgs({
    options: {
        testCase: {
            type: 'string',
            multiple: true,
            short: 't',
        },
        keepTempFiles: {
            type: 'boolean',
            short: 'k',
        },
        userDataDir: {
            type: 'string',
        },
        extensionsPath: {
            type: 'string',
        },
        codePath: {
            type: 'string',
        },
        logLevel: {
            type: 'string',
        },
        containerLogLevel: {
            type: 'string',
        },
        verbose: {
            type: 'boolean',
        },
    },
});

if (verbose === true) {
    logLevel = 'debug';
    containerLogLevel = 'debug';
} else if (verbose === false) {
    logLevel = 'warn';
    containerLogLevel = 'warn';
}

const testCases = testCasePaths.map((path) => JSON.parse(fs.readFileSync(path, 'utf-8')));
const logger = consoleLogger(logLevel ?? 'info');
const harness = new TestHarness(logger);

function reinstallSignalHandlers() {
    // vscode-automation and Playwright install their own SIGINT
    // handlers, which we need to override
    process.removeAllListeners('SIGINT');

    let attempts = 0;
    process.on('SIGINT', async () => {
        if (++attempts > 1) {
            logger.warn('Caught SIGINT again, aborting immediately');
            process.exit(1);
        }
        logger.warn('Caught SIGINT, shutting down...');
        try {
            await harness.abort();
        } finally {
            process.exit(0);
        }
    });
}
reinstallSignalHandlers();

(async () => {
    await harness.runTests(testCases, {
        doCleanup: !keepTempFiles,
        userDataDir,
        extensionsPath,
        codePath,
        containerLogLevel,
    });
})();
