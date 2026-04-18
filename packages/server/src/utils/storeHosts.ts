import fs from 'node:fs';
import path from 'node:path';
import { STORE_HOSTS_PATH } from '../config.js';

const DEFAULT_PREFIXES = ['80pd', 'ek10', 'j24n', 'jdpw', 'jloo'] as const;
const DEFAULT_SHARDS = [1, 2, 3, 4, 5] as const;

const STORE_HOST_RE = /^[a-z0-9-]+\.wowpic[0-9]+\.store$/i;
const STORE_URL_RE = /https?:\/\/([a-z0-9-]+\.wowpic[0-9]+\.store)(?=[:/?#]|$)/ig;

interface StoreHostsFile {
  hosts: string[];
  updatedAt: string;
}

const defaultHosts = DEFAULT_PREFIXES.flatMap(prefix =>
  DEFAULT_SHARDS.map(shard => `${prefix}.wowpic${shard}.store`),
);

let loaded = false;
const knownHosts = new Set<string>(defaultHosts);

function normalizeHost(host: string): string | null {
  const value = host.trim().toLowerCase();
  return STORE_HOST_RE.test(value) ? value : null;
}

function persist(): void {
  const dir = path.dirname(STORE_HOSTS_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const payload: StoreHostsFile = {
    hosts: [...knownHosts].sort(),
    updatedAt: new Date().toISOString(),
  };

  const tmpPath = `${STORE_HOSTS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, STORE_HOSTS_PATH);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let shouldPersist = false;

  try {
    if (fs.existsSync(STORE_HOSTS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_HOSTS_PATH, 'utf8')) as Partial<StoreHostsFile>;
      for (const host of parsed.hosts ?? []) {
        const normalized = normalizeHost(host);
        if (normalized) knownHosts.add(normalized);
        else shouldPersist = true;
      }
    } else {
      shouldPersist = true;
    }
  } catch (err) {
    console.error(`[storeHosts] failed to load ${STORE_HOSTS_PATH}: ${(err as Error).message}`);
    shouldPersist = true;
  }

  if (shouldPersist) {
    try {
      persist();
    } catch (err) {
      console.error(`[storeHosts] failed to persist ${STORE_HOSTS_PATH}: ${(err as Error).message}`);
    }
  }
}

export function listStoreHosts(): string[] {
  ensureLoaded();
  return [...knownHosts].sort();
}

export function learnStoreHost(host: string): boolean {
  ensureLoaded();
  const normalized = normalizeHost(host);
  if (!normalized || knownHosts.has(normalized)) return false;
  knownHosts.add(normalized);
  persist();
  console.log(`[storeHosts] learned ${normalized}`);
  return true;
}

export function learnStoreHostFromUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return learnStoreHost(hostname);
  } catch {
    return false;
  }
}

export function learnStoreHostsFromUnknown(value: unknown): number {
  ensureLoaded();

  const seen = new Set<unknown>();
  let learned = 0;

  function visit(input: unknown): void {
    if (input == null || seen.has(input)) return;
    if (typeof input === 'string') {
      let match: RegExpExecArray | null;
      STORE_URL_RE.lastIndex = 0;
      while ((match = STORE_URL_RE.exec(input)) !== null) {
        if (learnStoreHost(match[1])) learned++;
      }
      const normalized = normalizeHost(input);
      if (normalized && learnStoreHost(normalized)) learned++;
      return;
    }
    if (typeof input !== 'object') return;

    seen.add(input);

    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }

    for (const item of Object.values(input as Record<string, unknown>)) {
      visit(item);
    }
  }

  visit(value);
  return learned;
}
