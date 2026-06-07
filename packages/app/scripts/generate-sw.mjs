import fs from 'node:fs';
import path from 'node:path';

const buildDir = path.resolve('build');
const swPath = path.join(buildDir, 'sw.js');

function walk(dir) {
	const entries = [];
	for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, name.name);
		if (name.isDirectory()) {
			entries.push(...walk(full));
		} else {
			entries.push(full);
		}
	}
	return entries;
}

const staticAssets = [
	'/',
	'/index.html',
	'/manifest.json',
	'/favicon.ico',
	'/apple-touch-icon.png',
	'/apple-touch-icon-precomposed.png',
	'/apple-touch-icon-120x120.png',
	'/apple-touch-icon-120x120-precomposed.png',
	'/icon-192.png',
	'/icon-512.png',
];

const generatedAssets = fs.existsSync(path.join(buildDir, '_app'))
	? walk(path.join(buildDir, '_app')).map(file => `/${path.relative(buildDir, file).replaceAll(path.sep, '/')}`)
	: [];

const precache = [...new Set([...staticAssets, ...generatedAssets])]
	.filter(asset => fs.existsSync(path.join(buildDir, asset === '/' ? 'index.html' : asset.slice(1))));

const version = fs.existsSync(path.join(buildDir, '_app', 'version.json'))
	? JSON.parse(fs.readFileSync(path.join(buildDir, '_app', 'version.json'), 'utf8')).version
	: String(Date.now());

const source = `const SHELL_CACHE = 'manga-shell-${version}';
const PRECACHE = ${JSON.stringify(precache, null, 2)};

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(SHELL_CACHE);
		await cache.addAll(PRECACHE);
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names
			.filter(name => name.startsWith('manga-shell-') && name !== SHELL_CACHE)
			.map(name => caches.delete(name)));
		await clients.claim();
	})());
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== location.origin) return;
	if (url.pathname.startsWith('/api/')) return;
	if (url.pathname.startsWith('/providers/')) return;

	if (request.mode === 'navigate') {
		event.respondWith(cacheFirst('/index.html'));
		return;
	}

	if (PRECACHE.includes(url.pathname)) {
		event.respondWith(cacheFirst(url.pathname));
	}
});

async function cacheFirst(pathname) {
	const cache = await caches.open(SHELL_CACHE);
	const cached = await cache.match(pathname);
	if (cached) return cached;
	const response = await fetch(pathname, { cache: 'reload' });
	if (response.ok) await cache.put(pathname, response.clone());
	return response;
}
`;

fs.writeFileSync(swPath, source);
console.log(`[sw] generated ${swPath} assets=${precache.length} version=${version}`);
