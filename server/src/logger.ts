import winston, { format } from 'winston';

export interface Logger {
    debug(message: any, ...args: any[]);
    info(message: any, ...args: any[]);
    log(message: any, ...args: any[]);
    warn(message: any, ...args: any[]);
    error(message: any, ...args: any[]);
    child(options: Object): Logger;
}

export class WinstonAdapter implements Logger {
    private _logger: Logger;
    private _defaultLevel = 'debug';

    constructor(logger: Logger, defaultLevel?: string) {
        this._logger = logger;
        if (defaultLevel) {
            this._defaultLevel = defaultLevel;
        }
    }

    debug(message: any, ...args: any[]) {
        this._logger.debug(message, ...args);
    }

    info(message: any, ...args: any[]) {
        this._logger.info(message, ...args);
    }

    log(...args: any[]) {
        this._logger.log(this._defaultLevel, args[0] ?? undefined, ...args.slice(1));
    }

    warn(message: any, ...args: any[]) {
        this._logger.warn(message, ...args);
    }

    error(message: any, ...args: any[]) {
        this._logger.error(message, ...args);
    }

    child(options: Object) {
        return new WinstonAdapter(this._logger.child(options)) as Logger;
    }
}

export function consoleLogger(level?: string) {
    return new WinstonAdapter(
        winston.createLogger({
            level: level ?? 'debug',
            format: format.combine(format.colorize(), format.simple()),
            transports: new winston.transports.Console(),
        })
    );
}

class NoopLogger {
    debug(message: any, ...args: any[]): void {}
    info(message: any, ...args: any[]): void {}
    log(message: any, ...args: any[]): void {}
    warn(message: any, ...args: any[]): void {}
    error(message: any, ...args: any[]): void {}
    child(options: Object) {
        return this;
    }
}

export const noop = new NoopLogger();
