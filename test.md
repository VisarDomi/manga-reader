## iOS Safari regression tests

The matrix in [`test.txt`](test.txt) checks that each reader:

1. activates;
2. loads exactly one newer chapter after the first completed scroll;
3. restores the requested image after a real page reload.

Install the repository dependencies once:

```bash
npm install
```

Phone-harness setup is documented by
[`userscript-ios-test`](../../userscript-ios-test/README.md). Keep Safari
unlocked and foregrounded while a run is active.

Run the complete matrix:

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

The command type-checks and builds without incrementing the production version,
injects the current bundle, and runs the selected URLs and behaviors. It pauses
between visible phases and sites to avoid overwhelming iOS Safari.
