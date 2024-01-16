import type { Lease } from '../server';
import type { Logger } from '../logger';

declare global {
    namespace Express {
        export interface Request {
            user?: { id: string };
            lease?: Lease;
            logger?: Logger;
        }
    }
}
