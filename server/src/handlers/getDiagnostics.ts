import type { Request, Response } from 'express';
import { type Uri } from 'vscode';

import type { Server } from '../server';
import { SafeError, handleErrors } from '../errors';
import { FileType } from '../filesystem';

export default async function getDiagnostics(this: Server, req: Request, res: Response) {
    const { path: filePath, severity = 0 } = req.body;

    await handleErrors.bind(this)(req, res, async () => {
        const app = req.lease.app;
        let exists = false;

        const uri = { scheme: 'file', path: filePath } as Uri;
        try {
            if ((await app.fsproxy.stat(uri)).type == FileType.File) {
                exists = true;
            }
        } catch (error) {}

        if (!exists) {
            throw new SafeError('File not found');
        }

        const diagnostics = await app.fsproxy.getDiagnostics(uri, severity);
        res.json({ diagnostics, partialResult: true });
    });
}
