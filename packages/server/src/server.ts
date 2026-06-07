import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { PORT, CERT_KEY_PATH, CERT_PEM_PATH, FRONTEND_BUILD_DIR, WORKER_SOCKET_PATH, validateConfig, serverRoleFromEnv } from './config.js';
import { createApp } from './app.js';
import { listStoreHosts } from './utils/storeHosts.js';
import type { ProviderCoordinator } from './services/ProviderCoordinator.js';

validateConfig();

const SHUTDOWN_TIMEOUT = 10_000;

const role = serverRoleFromEnv();
let coordinator: ProviderCoordinator | null = null;
if (role !== 'api') {
    const imported = await import('./services/ProviderCoordinator.js');
    coordinator = new imported.ProviderCoordinator({ role });
}
const app = createApp(coordinator, role === 'api' ? { apiSocketPath: WORKER_SOCKET_PATH } : {});

const sslOptions = {
    key: fs.readFileSync(CERT_KEY_PATH),
    cert: fs.readFileSync(CERT_PEM_PATH),
};

const server = https.createServer(sslOptions, app);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`manga-reader backend running on https://localhost:${PORT}`);
    console.log(`Serving frontend: ${FRONTEND_BUILD_DIR}`);
    console.log(`[server] role=${role}${role === 'api' ? ` workerSocket=${WORKER_SOCKET_PATH}` : ''}`);
    console.log(`[storeHosts] loaded ${listStoreHosts().length} hosts`);

    void coordinator?.start();

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

    coordinator?.destroy().catch(() => {});

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
