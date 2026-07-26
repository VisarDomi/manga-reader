## iOS Safari regression tests

The repository contains its own remote debugger and phone test runner. The
matrix in [`test.txt`](test.txt) checks that each reader:

1. activates;
2. loads exactly one newer chapter after the first completed scroll;
3. restores the requested image after a real page reload.

One-time setup on a new development machine:

```bash
npm install
```

Generate and trust the HTTPS certificate by following
[`certificate.md`](certificate.md). With `npm run tests:server` still running:

1. Open the `https://<laptop-ip>:19999/debug.user.js` URL printed by
   `npm run tests:setup`.
2. Install it in the iOS userscript manager.
3. Give the userscript extension permission to run on all tested websites.
4. Keep Safari unlocked and foregrounded. Temporarily set display auto-lock to
   **Never**, then restore the original setting after testing.

Then open any page in Safari and run:

```bash
npm run tests
```

The test command type-checks and builds without incrementing the production
version, starts the repository-local bridge when needed, injects the current
bundle, and runs every URL in `test.txt`. It enforces a minimum one-second pause
between phases and sites to avoid overwhelming iOS Safari.

Configuration:

- `IOS_DEBUG_ORIGIN` — local controller origin, default
  `https://127.0.0.1:19999`
- `IOS_DEBUG_HOST` — LAN address embedded in the generated phone userscript
- `IOS_DEBUG_PORT` — bridge port, default `19999`
- `IOS_DEBUG_CERT` / `IOS_DEBUG_KEY` — custom HTTPS certificate paths
- `IOS_DEBUG_CA` — custom public root CA path for `/api/cert`
- `IOS_TEST_SETTLE_MS` — delay between tests, clamped to at least `1000`
