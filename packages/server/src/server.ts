import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { PORT, CERT_KEY_PATH, CERT_PEM_PATH, FRONTEND_BUILD_DIR, validateConfig } from './config';
import { createApp } from './app';
import { BrowserSession } from './services/BrowserSession';
import { startPrewarm } from './utils/prewarm';

validateConfig();

const SHUTDOWN_TIMEOUT = 10_000;

// Server owns BrowserSession — passes ref to app, destroys on shutdown.
const browserSession = new BrowserSession('comix.to', 'https://comix.to');
const app = createApp(browserSession);

const sslOptions = {
    key: fs.readFileSync(CERT_KEY_PATH),
    cert: fs.readFileSync(CERT_PEM_PATH),
};

const server = https.createServer(sslOptions, app);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`comix-backend running on https://localhost:${PORT}`);
    console.log(`Serving frontend: ${FRONTEND_BUILD_DIR}`);

    startPrewarm();

    // BrowserSession init is async — server is available immediately,
    // browser fallback becomes available once init completes.
    browserSession.init().catch(err => {
        console.error(`[browserSession] init failed: ${err.message}`);
    });

    const networkInterfaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(networkInterfaces)) {
        addrs?.forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`LAN: https://${iface.address}:${PORT}`);
            }
        });
    }
});

function shutdown(signal: string) {
    console.log(`${signal} received — shutting down gracefully...`);

    browserSession.destroy().catch(() => {});

    server.close(() => {
        console.log('All connections closed. Exiting.');
        process.exit(0);
    });

    setTimeout(() => {
        console.error('Shutdown timed out after 10s — forcing exit.');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
