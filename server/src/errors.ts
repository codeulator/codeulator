import Sentry from '@sentry/node';
import { verifyToken } from './auth';
import { randomUUID } from 'crypto';

import type { Request, Response } from 'express';
import type { Server, Lease } from './server';

// SafeError is used to distinguish errors that are safe to send to the client
export class SafeError extends Error {
    code = 'SafeError';
    status = 400;
    recoverable: boolean;
    sensitive?: boolean;

    constructor(
        ...args:
            | any[]
            | [
                  {
                      message?: string;
                      status?: number;
                      recoverable?: boolean;
                      cause?: Error;
                      sensitive?: boolean;
                  }
              ]
    ) {
        super(args[0].message ?? args[0]);
        const status = args[0].status ?? args[1];
        if (status) {
            this.status = status;
        }
        this.recoverable = args[0].recoverable ?? true;
        this.cause = args[0].cause;
        if (args[0].sensitive) {
            this.sensitive = true;
        }
    }
}

export function sanitizeError(error: Error & { recoverable?: boolean }) {
    if (error instanceof SafeError) {
        return error;
    } else {
        return new SafeError({
            message: 'Internal error, please try again later',
            cause: error,
            status: 500,
            // All errors considered fatal by default (will terminate the lease)
            recoverable: error.recoverable ?? false,
        });
    }
}

export async function handleErrors(this: Server, req: Request, res: Response, fn: () => Promise<void>) {
    const { liveShareUrl, leaseTTL, mustUsePool = false } = req.body;
    let lease: Lease | undefined;

    req.logger = this.logger.child({
        request_id: randomUUID().replaceAll('-', ''),
        http_path: req.path,
        ip: req.ip,
    });

    try {
        if (process.env.SFD_REFUSE_REQUESTS) {
            throw new SafeError('The service is at capacity. Please try again later.', 429);
        }

        // Authenticate the request
        let uid: string | undefined;
        if (req.headers.authorization) {
            const token = req.headers.authorization.substring(7);
            ({ user_id: uid } = await verifyToken(token));
            req.user = { id: uid };
            req.logger = req.logger.child({ user_id: uid });
        }
        if (!req.user && !process.env.SFD_ALLOW_ANONYMOUS) {
            throw new SafeError('Unauthorized', 401);
        }

        req.logger.debug('Calling getOrCreateLease');
        lease = await this.getOrCreateLease(req, liveShareUrl, leaseTTL, mustUsePool);
        req.lease = lease;
        req.logger = req.logger.child({ lease_id: lease.id });

        req.logger.debug('Calling performOperation');
        await lease.app.performOperation(() => fn());
    } catch (error) {
        if (!error.recoverable) {
            // Terminate the lease because the app might be in an unrecoverable state
            this.finalizeLease(lease);
        }

        // Log the error (as a warning if it's a SafeError)
        if (error instanceof SafeError) {
            req.logger.warn(error as any);
        } else {
            req.logger.error(error as any);
        }

        const sanitized = sanitizeError(error);
        if (!res.headersSent) {
            res.status(sanitized.status).send({ error: { message: sanitized.message } });
        }
        if (sanitized.status >= 500) {
            Sentry.captureException(error);
        }
    }
}
