import { parseArgs } from 'node:util';
import { Quality } from 'vscode-automation';

import { ApplicationPool } from '../applicationPool';
import { LiveShare } from '../liveshare';
import { defaultCodePath } from '../server';

const {
    values: { name, url, codePath },
} = parseArgs({
    options: {
        name: {
            type: 'string',
            short: 'n',
            default: 'AI',
        },
        url: {
            type: 'string',
            short: 'u',
        },
        codePath: {
            type: 'string',
            default: defaultCodePath(),
        },
    },
});

const pool = new ApplicationPool();
const app = await pool.acquire({
    codePath: codePath,
    logger: console,
    quality: Quality.Dev,
});

const liveShare = new LiveShare(app);
await liveShare.join(name, url);
await liveShare.waitForReadWriteAccess();
