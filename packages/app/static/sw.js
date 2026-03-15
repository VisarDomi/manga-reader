// This service worker exists solely to satisfy iOS 18 PWA requirements
// (Add to Home Screen, standalone mode). It does not cache anything —
// the app is not designed to work offline.
const CACHE_NAME = 'pwa-v1';

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(clients.claim());
});

self.addEventListener('fetch', () => {
	// No-op: listener must exist for iOS 18 PWA installability,
	// but not calling respondWith() lets the browser handle requests natively
});
