// Private folders and power-cut-safe writes for the PC server's files.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Create a folder (and its parents) readable only by this user. */
export function privateDirectory(directory) {
    if (fs.existsSync(directory)) return;
    const parent = path.dirname(directory);
    privateDirectory(parent);
    fs.mkdirSync(directory, { mode: 0o700 });
    syncDirectory(parent);
}

export function syncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/** Write, fsync, rename, and fsync the parent directory. */
export function durableWrite(file, text) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, text);
        fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    syncDirectory(path.dirname(file));
}
