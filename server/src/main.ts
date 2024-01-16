import type { Logger } from './logger';

import opentelemetry from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

if (process.env.SFD_TELEMETRY_ENABLED) {
    const traceExporter = new OTLPTraceExporter();
    const metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
    });
    const sdk = new opentelemetry.NodeSDK({
        serviceName: 'sfd',
        traceExporter,
        metricReader,
        instrumentations: [getNodeAutoInstrumentations()],
        autoDetectResources: true,
    });
    sdk.start();
}

// Using dynamic imports ensures modules are loaded _after_ the OT SDK is initialized
const { default: winston, format } = await import('winston');
const { WinstonAdapter } = await import('./logger');

const mainLogger = new WinstonAdapter(
    winston.createLogger({
        level: process.env.SFD_LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        format: format.combine(format.timestamp(), format.json()),
        transports: new winston.transports.Console(),
    })
);

let appLogger: Logger = null;
if (process.env.SFD_APP_LOG_PATH) {
    appLogger = new WinstonAdapter(
        winston.createLogger({
            level: 'debug',
            format: format.simple(),
            transports: new winston.transports.File({ filename: process.env.SFD_APP_LOG_PATH }),
        })
    );
}

const { Server, defaultCodePath } = await import('./server');
const server = new Server(mainLogger);

(async () => {
    await server.start({
        codePath: defaultCodePath(),
        port: process.env.SFD_PORT ? parseInt(process.env.SFD_PORT) : 3100,
        appLogger,
    });
})();
