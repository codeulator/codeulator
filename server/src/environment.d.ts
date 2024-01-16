declare global {
    namespace NodeJS {
        interface ProcessEnv {
            NODE_ENV: string;
            OPENAI_API_KEY: string;
            SFD_ALLOW_ANONYMOUS: string;
            SFD_APP_LOG_PATH: string;
            SFD_LOG_LEVEL: string;
            SFD_PORT: string;
            SFD_REFUSE_REQUESTS: string;
            SFD_TELEMETRY_ENABLED: string;
        }
    }
}

export {};
