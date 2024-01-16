import type { Request, Response } from 'express';
import { analyzeDirectory, analyzeFile } from '../analyze';
import { SafeError, handleErrors } from '../errors';

export async function read(req: Request, res: Response) {
    const { path: filePath } = req.body;

    await handleErrors.bind(this)(req, res, async () => {
        const { lease } = req;
        let app = lease.app;

        //TODO: implement 'selection'
        if (filePath === 'selection') {
            throw new SafeError("Getting the user's selection is temporarily disabled");
        }

        // Open the file in the editor so users can see we're reading it
        if (filePath !== 'terminal') {
            await this.openFile(app, this.normalizePath(filePath));
        }

        const options = {
            fs: app.fsproxy,
            driver: app.code.driver,
            ...req.body,
        };

        const result = await analyzeFile(options);
        lease.addToReadHistory(filePath);
        res.send(result.data);
    });
}

export async function explore(req: Request, res: Response) {
    const { path: filePath } = req.body;

    await handleErrors.bind(this)(req, res, async () => {
        const { lease } = req;

        if (filePath === 'terminal' || filePath === 'selection') {
            throw new SafeError('Invalid path. Did you mean to use the readFile operation?');
        }

        const options = {
            fs: lease.app.fsproxy,
            cacheDir: lease.cacheDir,
            ...req.body,
        };

        const result = await analyzeDirectory(options);
        res.json(result);
    });
}
