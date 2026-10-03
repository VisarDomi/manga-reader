# notes

The six provider apps are the only products: see `apps/ios/DEVELOPMENT.md` and
`apps/ios/PAID-NATIVE.md`. Keep runtime behavior in `src/`.

## Sites supported
[sites.ts](src/core/sites.ts)

## Manual PC Load / Save

Home shows **Load** and **Save** beneath the loaded-series text when the PC is
available. Save replaces the shared PC reading state; Load replaces local reading
state with that save, even if older. No timestamp merging, automatic home backup,
progress publisher, or periodic imports. Discovery checks availability only.
Offline PC hides the controls. The first explicit Save creates the shared state.

One canonical snapshot per provider, with the previous save retained for recovery.
Load validates first and replaces IndexedDB atomically; sessions stay local.
The app preserves fractional progress/history in compatible metadata. See
[manual PC details](apps/ios/DEVELOPMENT.md) and [server operations](server/BACKUPS.md).
Builds read this repository's server key; see [.env.example](.env.example). Built
app bundles contain the key: never publish them. Database/network work remains in
the compute worker.

## Downloads

Each manga keeps previous + current + next chapters downloaded, prepared on Home
and moved/pruned while reading; local history and other manga's windows stay.
There is no server history, tracking or provider authentication. Both reader ends
use 50svh padding.
