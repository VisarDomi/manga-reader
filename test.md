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

The shared `userscript-ios-test` package builds one debugger userscript for all
userscript repositories. Set `IOS_DEBUG_HOST` only when automatic LAN-address
detection is not correct, then rebuild and reinstall that shared debugger.

Generate and trust the HTTPS certificate by following
[`certificate.md`](certificate.md). With `npm run tests:server` still running:

1. Install
   [`userscript-ios-test-debug.user.js`](../../userscript-ios-test/dist/userscript-ios-test-debug.user.js),
   or open `https://192.168.1.197:37777/userscript-ios-test-debug.user.js`
   while the bridge is running.
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

Run only the Asura once-per-chapter tracking regression:

```bash
npm run tests -- --test tracking --site asura
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
- `tests/ios/config.json` — repository identity used by the shared harness
- `IOS_DEBUG_CERT` / `IOS_DEBUG_KEY` — custom HTTPS certificate paths
- `IOS_DEBUG_CA` — custom public root CA path for `/api/cert`
- `IOS_TEST_SETTLE_MS` — delay between tests, clamped to at least `1000`
