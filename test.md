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

The debugger is intentionally specific to the original development setup:
`192.168.1.197:37777`. It is not generated from environment variables. After
cloning the repository to another machine, change the fixed values before
installing the debugger:

- In `tests/ios/manga-reader-debug.user.js`, change both `@connect` and
  `SERVER` to the laptop's LAN address. Change the port in `SERVER` if needed.
- If changing port `37777`, also change the bridge default in
  `tests/ios/bridge_server.py` and `bridgeOrigin` in `tests/ios/run.mjs`.

Keep these values identical. The bridge serves the checked-in userscript
verbatim.

Generate and trust the HTTPS certificate by following
[`certificate.md`](certificate.md). With `npm run tests:server` still running:

1. Open `https://192.168.1.197:37777/manga-reader-debug.user.js`, or the
   corresponding fixed URL configured above.
2. Install it in the iOS userscript manager.
3. Give the userscript extension permission to run on all tested websites.
4. Keep Safari unlocked and foregrounded. Temporarily set display auto-lock to
   **Never**, then restore the original setting after testing.

Then open any page in Safari and run:

```bash
npm run tests
```

or

```bash
npm run tests -- "https://..."
```

The test command type-checks and builds without incrementing the production
version, starts the repository-local bridge when needed, injects the current
bundle, and runs every URL in `test.txt`. It enforces a minimum one-second pause
between phases and sites to avoid overwhelming iOS Safari.

Configuration:

- `IOS_DEBUG_ORIGIN` — local controller origin, default
  `https://127.0.0.1:37777`. If overridden, the userscript and bridge port must
  be edited to match.
- `IOS_DEBUG_HOST` — address used for certificate generation and printed setup
  URLs only; it does not rewrite the userscript.
- `IOS_DEBUG_PORT` — bridge port, default `37777`
- `IOS_DEBUG_CERT` / `IOS_DEBUG_KEY` — custom HTTPS certificate paths
- `IOS_DEBUG_CA` — custom public root CA path for `/api/cert`
- `IOS_TEST_SETTLE_MS` — delay between tests, clamped to at least `1000`
