# September 22 recovery pass — native build 10

The six provider builds share the UI and provider extraction in `src/`.
Public GET/HEAD metadata and image requests now retry connectivity failures,
timeouts and HTTP 408/429/500/502/503/504 with cancellable exponential backoff.
URLSession waits for a usable connection. PC requests remain finite and optional;
POST/write operations are not replayed. TLS/certificate failures and permanent
HTTP responses retain their normal failure behavior.

ImageDownloader remains the only image/download owner. Its existing persisted
previous/current/next windows and covers restart preparation at bootstrap. A
completed file plus MIME commit is reused; unfinished files are downloaded again.
Visible requests still preempt background transfers, including retry/backoff.
No new UI, migration, polling job or cold-restore policy was introduced.

Validation: `swift run` from apps/ios on the Mac, `npm run test:unit` and
`npx tsc -p apps/ios/tsconfig.json --noEmit`. Core tests cover failure/503 recovery,
cancellation, priority, partial files, cache reuse and store recreation.

## Physical validation

All provider builds were installed in place using their existing paid identities.
See `robustness-verification.json` for sanitized results. Cold-launch checks passed on the iPhone. A read queued with both Wi-Fi and cellular off completed with HTTP 200 after Wi-Fi returned, using the same pending request without a reload or manual retry.

The existing monthly runner successfully renewed every delivered provider build,
retaining the same app identities/data. The scheduler is resumed and its installed-app
scan exits successfully. No new background item or power-setting change was made.
