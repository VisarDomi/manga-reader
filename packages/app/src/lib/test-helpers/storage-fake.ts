/** Shared in-memory storage fake — same interface as services/storage.js */
export function createStorageFake() {
  const store = new Map<string, string>();

  const fake = {
    getJson: <T>(key: string, fallback: T): T => {
      const raw = store.get(key);
      if (raw === undefined) return fallback;
      try { return JSON.parse(raw) as T; }
      catch { return fallback; }
    },
    setJson: (key: string, value: unknown) => {
      store.set(key, JSON.stringify(value));
    },
    getString: (key: string, fallback: string) => store.get(key) ?? fallback,
    setString: (key: string, value: string) => store.set(key, value),
    remove: (key: string) => { store.delete(key); },
  };

  return { store, fake };
}
