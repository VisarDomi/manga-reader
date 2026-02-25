import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = parseInt(process.env.PORT || '11555', 10);
export const SSL_DIR = process.env.SSL_DIR || path.join(os.homedir(), '.local/share/mkcert/pwa');
export const FRONTEND_BUILD_DIR = process.env.FRONTEND_BUILD_DIR || path.join(__dirname, '..', '..', 'app', 'build');
export const CACHE_MAX_AGE = parseInt(process.env.CACHE_MAX_AGE || '86400', 10);
export const PROXY_TIMEOUT = parseInt(process.env.PROXY_TIMEOUT || '10000', 10);
export const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
export const CERT_KEY_PATH = process.env.CERT_KEY_PATH || path.join(SSL_DIR, 'key.pem');
export const CERT_PEM_PATH = process.env.CERT_PEM_PATH || path.join(SSL_DIR, 'cert.pem');
export const ROOT_CA_PATH = process.env.ROOT_CA_PATH || path.join(os.homedir(), '.local/share/mkcert/rootCA.pem');

// Startup validation — crash early with clear messages
export function validateConfig(): void {
  if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`Invalid PORT: "${process.env.PORT}". Must be a number between 1 and 65535.`);
    process.exit(1);
  }

  if (!fs.existsSync(CERT_KEY_PATH)) {
    console.error(`SSL key not found: ${CERT_KEY_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(CERT_PEM_PATH)) {
    console.error(`SSL cert not found: ${CERT_PEM_PATH}`);
    process.exit(1);
  }
}
