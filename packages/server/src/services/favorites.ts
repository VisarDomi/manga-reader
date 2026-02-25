import fs from 'node:fs';
import path from 'node:path';
import { FAVORITES_FILE } from '../config';

export interface FavoriteManga {
  slug: string;
  title: string;
  cover: string;
  latestChapter: number | null;
  author?: string;
  status?: string;
}

export function readAll(): FavoriteManga[] {
  try {
    const data = fs.readFileSync(FAVORITES_FILE, 'utf-8');
    return JSON.parse(data) as FavoriteManga[];
  } catch {
    return [];
  }
}

function writeAll(items: FavoriteManga[]): void {
  const dir = path.dirname(FAVORITES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FAVORITES_FILE, JSON.stringify(items, null, 2));
}

export function add(slug: string, manga: Omit<FavoriteManga, 'slug'>): void {
  const items = readAll().filter(m => m.slug !== slug);
  items.push({ slug, ...manga });
  writeAll(items);
}

export function remove(slug: string): void {
  const items = readAll().filter(m => m.slug !== slug);
  writeAll(items);
}
