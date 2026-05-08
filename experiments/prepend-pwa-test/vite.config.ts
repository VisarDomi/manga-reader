import { defineConfig } from 'vite';
import fs from 'fs';
import os from 'os';
import path from 'path';

function getHttpsConfig() {
  try {
    const certDir = path.join(os.homedir(), '.local/share/mkcert/pwa');
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    }
  } catch (_error) {}
  return undefined;
}

export default defineConfig({
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 32213,
    https: getHttpsConfig(),
  },
});
