# Network interruption and process-kill pass

Scope: all six Manga apps, Gallery Downloader, Hitomi/Imhen, Ytb and Tango.
Preserve existing UI, native-specific features and each app's restoration policy.
AGENTS.md/readme.md/test.txt are user-owned. Gallery Downloader's local APNs work
is paused and must not be deployed or incorporated by this pass.

- [x] Manga: transient metadata/image failures, priority/cancellation, persisted download window, interrupted files, cold Home/reader/Back.
- [x] Gallery Reader: image-cache persistence, canceled queued transfers, network recovery, WebKit session restore.
- [x] Gallery Downloader: audit shipping baseline separately from APNs WIP; incomplete transfer recovery, catalog/checkpoint integrity, offline viewing and cold restore.
- [x] Ytb: metadata interruption, WebKit video failures, durable positions/history, cold restore.
- [x] Tango: session refresh single-flight/persistence, network versus login failure, playback interruption, fresh-list cold launch.
- [x] Build/install changed providers, physical checks, monthly renewal, cleanup, commits and recovery documentation.

## Confirmed audit findings

Manga: background image failure removes its job without scheduling another attempt;
metadata failure can end the initial page/chapter load. Existing image retries
cover visible HTML images, not all retained background downloads. Download windows,
URLs, progress and view checkpoints are atomically persisted; transfers use a
foreground URLSession and do not continue after the user force-quits the app.

Gallery Reader: TransferGate checks cancellation only after a queued waiter finally
gets a slot, so canceled requests can remain stuck behind other network work.
Manga, Gallery Reader and Ytb native HTTP boundaries currently make one attempt
and do not wait for connectivity. Their PC checks must remain short and optional.

Tango: refresh POST rotates the refresh token. It must not be replayed like an
ordinary GET after an ambiguous connection loss. Review persistence at response
headers as well as the existing save after the complete refresh response.

Tango exception: no cold stream/list checkpoint; every new process fetches a fresh Home list. Network recovery remains required.

See each app’s apps/ios/ROBUSTNESS.md for the implemented changes and repeatable tests.

Delivered all 11 apps. Real offline requests in Asura/Hitomi/Ytb/Tango finished
with HTTP 200 after Wi-Fi returned, without reissue/reload. All 11 cold-launch
checks passed; Gallery Downloader also passed reader restart/Back. Its temporary
inspection build was replaced by shipping build 11. All 11 monthly renewals and
the resumed scheduler scan passed. Detailed per-repo evidence is in
`apps/ios/robustness-verification.json`.
