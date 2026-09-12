# Real iPhone extension debugging from Linux

Shared Mac connection instructions: [mac-access.md](/home/visar/Documents/environment/mac-access.md).
Ethernet is now `192.168.1.198`; USB wireless remains DHCP.

Current paid Reader Extensions deployment (September 12): see
[paid signing](../../../reader-extensions/PAID-SIGNING.md). The host is now
`com.visar.readerextensions.paid`, installed and launched with team `65U58U86DD`.
Its four extension profiles include this phone and expire September 12, 2027.
The original personal-team deployment instructions below are historical; use
the configured paid helper and its profile preflight.

Working runbook, verified incrementally on 2026-09-11. Keep runtime changes in
Manga Reader and packaging in the sibling `../../reader-extensions` repository.
Do not edit user-owned `readme.md` / `README.md` or `test.txt`.

For the installed LiveContainer host, use [LC setup](../apps/livecontainer/SETUP.md).
For the six provider-specific native apps, use [iOS development](../apps/ios/DEVELOPMENT.md)
and the [September 12 handoff](2026-09-12-handoff.md). The earlier
[LiveContainer investigation](livecontainer-plan.md) records research, not current
deployment status. Gallery remains a normal installed app.

## Connect to the existing Hackintosh

September 12 network update: Ethernet (`en0`, service `Ethernet`) is now manually
configured as **192.168.1.198/24**, gateway `192.168.1.1`, DNS `8.8.8.8` and
`8.8.4.4`. USB wireless (`802.11ac NIC`, `en3`) remains DHCP. The old `.46`
address briefly fell back to `169.254.115.35`; IPv6 SSH still worked and the
wireless Extensions renewal completed during that outage. This was not evidence
that the Mac had slept. SSH on `.198`, default route and DNS were verified.
The dedicated trust file includes `.198` with the same previously trusted key.


From this repository on Linux:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts \
  visar@192.168.1.198
```

Use these SSH options for SCP/rsync too. Plain SSH currently encounters a stale
entry in `~/.ssh/known_hosts` from another OS at the same address. The dedicated
macOS trust file works; do not delete keys or disable host verification.
If connection times out, check that the Mac is awake and on the LAN.

Verified: macOS 15.7.9, Xcode 26.3 (17C529), selected Xcode at
`/Applications/Xcode.app/Contents/Developer`, GUI UID 501. `xcrun devicectl list
devices` finds Visar's iPhone 12 Pro Max as available/paired. The pairing UDID is
`00008101-000639912881401E`; the CoreDevice identifier is a different UUID.
The phone reports iOS 26.6.2 and Developer Mode enabled. Its current transport
is wired, with an active tunnel; the inspector's `--native` mode was also verified.

## Build, sign, and update the existing app

The configured deployment file is
`/home/visar/Documents/work/reader-extensions/deploy.local.json`.
The active Mac mirror is `/Users/visar/Developer/reader-extensions`.
The older `/Users/visar/Developer/gallery-reader-extension` is retained for
diagnostic tools and its Python environment, not current app deployment.

Read `../../reader-extensions/notes.md` and `../../reader-extensions/REFRESH.md`.
Check `pgrep -fl 'xcodebuild|refresh.py'` and
`launchctl list com.visar.reader-extensions-refresh` on the Mac before building.
Pause the idle renewal job before changing its inputs; do not interrupt an active
sign/install. Preserve other readers' staged bundles and pending experiments.

```bash
# From /home/visar/Documents/work/reader-extensions
npm run build -- manga-reader
npm run verify
npm run mac -- sync
npm run mac -- build
npm run mac -- status
```

Build runs in a GUI LaunchAgent for Keychain access. Wait for no running PID,
`LastExitStatus = 0`, and `** BUILD SUCCEEDED **`. Then:

```bash
npm run mac -- check
npm run mac -- install
npm run mac -- finish
```

The helper verifies all embedded file hashes and the complete signature before
installing. Keep host ID `com.visar.galleryreader.extensiontest` and Manga suffix
`.MangaReader`. No uninstall, website-data clearing, or database reset is needed.
Follow REFRESH.md to approve the deliberately delivered baseline and resume
renewal after the final build; do not leave renewal silently paused.

## Attach to native Safari

Existing tool source: `../gallery-reader/tests/ios/native-inspector.py`.
Mac Python: `/Users/visar/Developer/gallery-reader-extension/inspector-venv/bin/python`.
Copy the current inspector script to a diagnostic directory on the Mac before
running it, so it includes the current Manga host selectors.

The inspector supports `--site manga`, `--page-id ID`, `--evaluate-file PATH`,
`--screenshot PATH`, and bounded `--observe-seconds` (maximum 45 seconds).
Default transport uses the trusted USB pairing. `--native` uses the existing
paired Mac network tunnel without USB. Keep the phone unlocked with Safari
foregrounded and Web Inspector enabled in Safari's Advanced settings.
If multiple Manga tabs are reported, select the actual Asura page ID explicitly.

`--reload`, `--navigate`, `--home`, and `--reader` navigate the real tab.
`--reader --site manga` clicks a chapter link, **not a cover-resume link**.
For this investigation the user will physically tap the cover and scroll;
synthetic scrolling is not evidence that their gesture behaves correctly.

Verified attachment command after copying the helper:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts \
  visar@192.168.1.198 \
  '/Users/visar/Developer/gallery-reader-extension/inspector-venv/bin/python /Users/visar/Developer/manga-reader-diagnostics/native-inspector.py --native --site manga --observe-seconds 0'
```

The environment currently contains pymobiledevice3 11.9.2. Its urllib3/LibreSSL
warning did not prevent native attachment. A successful snapshot showed Asura
page ID 1, visible Safari, one Manga startup, and all 343 home cards. Page IDs can
change; enumerate before using a saved ID. A Userscripts loader also appears
among inspector scripts; that alone does not prove a matching userscript ran.

Enable Manga Reader and grant Asura access. Disable its matching userscript so
two runtimes cannot compete. The optional `npm run tests` harness injects a
userscript and is not the installed-extension test workflow.

## Capture and interpret the two regressions

First capture the installed baseline. Observe cover tap → restored reader →
touch during restore separately from ordinary reader scrolling. Record trusted
touch events, programmatic scroll requests, scroll/scrollend timing, image loads,
chapter appends, URL changes, and frame gaps. Keep capture bounded and avoid
continuous full-DOM snapshots or per-frame console output that adds its own jank.
Frame gaps indicate delayed callbacks, not proof of a particular blocking stack;
use a separate native profiler pass when attribution is needed.

`tests/ios/observe-gestures.py` and adjacent `gesture-probe.js` provide a bounded
observer for Asura. Copy both to `/Users/visar/Developer/manga-reader-diagnostics/`.
For capture across cover navigation, build Manga with the optional probe:

```bash
# From manga-reader, after pausing the idle renewal job on the Mac:
MANGA_GESTURE_PROBE=1 npm run build:extension
cd ../../reader-extensions
npm run stage -- manga-reader
npm run mac -- sync
npm run mac -- build
# Wait/check/install/finish as described above.
```

Run `observe-gestures.py` with the same Mac Python, `--page-id 1 --seconds 180`,
and redirect SSH output to `.ios-debug/gestures-baseline.jsonl` on Linux. Add
`--native` when using the paired tunnel without USB. Wait for `ARMED` before
asking the user to reproduce. The collector attaches a transient probe to the
current document; the diagnostic extension starts it in new Asura documents
before reader initialization. It batches events once per second and restores
wrapped scroll/history methods on expiry (five minutes per new document).
It never initiates a tap, scroll, reload, or storage operation. Its Runtime
evaluation explicitly uses `userGesture: false`; the generic inspector helper's
convenience evaluator defaults to true, which can change page activation.
Use `--profile` for a separate native sampled-stack pass; it adds overhead and
may emit large logs. Rebuild/reinstall with `MANGA_GESTURE_PROBE` omitted after
capture so normal bundles contain no diagnostic observer.

Complete collector setup from the Manga repository on Linux:

```bash
mkdir -p .ios-debug
scp -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts \
  tests/ios/observe-gestures.py tests/ios/gesture-probe.js \
  visar@192.168.1.198:/Users/visar/Developer/manga-reader-diagnostics/
ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts \
  visar@192.168.1.198 \
  '/Users/visar/Developer/gallery-reader-extension/inspector-venv/bin/python /Users/visar/Developer/manga-reader-diagnostics/observe-gestures.py --page-id 1 --seconds 300' \
  > .ios-debug/gestures-installed.jsonl 2>&1
```

Run that SSH collector in a tool session that can yield while it continues.
Inspect the log for `ARMED`, then invite physical reproduction. Only one native
inspector should attach to the same tab at a time. Do not start the generic
snapshot helper concurrently with the collector.

Do not rely on `Page.setBootstrapScript` here: sending it to the WebContent
target timed out; sending it to the parent protocol returned `'Page' domain was
not found`. Public WebKit protocol availability does not establish support on
this phone's remote-inspector endpoint. The diagnostic build is the reliable
way to observe initialization from its first statement.

Protocol references: [WebKit Page commands](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/Page.json)
and [Web Inspector timelines](https://webkit.org/web-inspector/timelines-tab/).

Code findings before live reproduction: `restoreScroll` in `src/routes/reader.ts`
walks images with repeated `scrollTo` calls and has no user-input cancellation.
The 100ms settling timer is present in `src/core/scroll-settle.ts` (version 283).
Worker-owned storage does not move DOM layout, image style changes, or scroll
calls off the main thread. These are hypotheses to correlate with phone traces,
not a claim that the user's live regression has already been reproduced.

Baseline identity check: local Manga bundle and staged host bundle SHA-256 both
start `3b5aea321a8cce3e`; staged manifest is version 283. `npm run mac -- check`
passed all four readers' embedded hashes and the signed Mac app verification.
This verifies the Mac artifact, not the bytes installed on the phone. Native
snapshot attachment needed no rebuild. Capturing initialization across navigation
required the optional diagnostic build. The idle Reader Extensions renewal job
was paused before staging it; restore normal packaging and renewal after testing.

The diagnostic build subsequently passed Xcode signing, embedded hash checks,
and `devicectl` installation under the existing host ID. The build job was
unloaded with `finish`. The collector reported `ARMED` over USB on Asura page 1.
Installing can reinject the extension into an already open document (the current
boot guard counted two entries); reload once before reproduction to start a fresh
document. This is why an install confirmation alone is insufficient.

The collector re-enables Console/Runtime after a provisional target commits, so
navigation into a new WebContent process does not silently lose the reader trace.
Ignore replayed console batches older than the current `ARMED` event; compare
their epoch/document ID. Each new document emits its own `armed` event. The current
capture file is `.ios-debug/gestures-installed.jsonl`. At this point the runtime
fix is pending the user's physical reproduction, and renewal is temporarily paused.
Local smoke validation passed event capture, calling/restoring the original
scroll/history methods, stopping the probe, and restricting it to Asura. Python
and JavaScript syntax checks passed. These checks validate the diagnostic, not
the unimplemented runtime fix or the user's scrolling experience.

## September 11 findings and fix validation in progress

The user physically reproduced restore and slow scrolling. In the baseline
restore to image 31, input started at 2305ms; restore issued another `scrollTo`
at 2318ms, then kept jumping through the chapter. Another sequence measured
image 2 at 1676px while image 1 still had its 1000px placeholder; the latter's
900×16000 intrinsic size was already available, but its load listener had not
updated the style. Restore then waited on an offscreen lazy image until physical
scrolling brought it into range. This demonstrates both input override and the
cached-image geometry race.

Two native ScriptProfiler/Timeline recordings are saved as
`.ios-debug/reader-profile.jsonl` and `.ios-debug/reader-profile-2.jsonl`.
The second 90-second pass recorded 7,552 JavaScript evaluations (maximum 2.13ms),
a 39.04ms Paint inside a 40.72ms Composite, and a maximum Layout of 0.46ms.
That pass recorded a long painting/compositing interval and no comparably long
JavaScript evaluation; it does not establish the cause of the perceived stall.
Larger callback gaps in the initial gesture trace (228ms)
are symptoms without native stack attribution, not proof of worker failure.
Filter replayed Console batches by the current probe ID/ARMED epoch when comparing
passes. Timeline records can arrive as a large nested batch at stop; flatten
`children` and do not treat the enclosing recording/frame duration as JS CPU time.

Local changes under test: cancel restore on input (including during chapter
fetch), reconcile cached intrinsic dimensions before offset reads, jump once
when all preceding images are cached, suppress settled updates while a finger
is held down. A temporary `decoding="async"` change was a hypothesis only.
The user requested deeper native attribution rather
than a rendering workaround, so `decoding="async"` was removed before any runtime
fix was installed. The phone still has the baseline diagnostic build. The Mac
candidate build was completed but not installed; its job was unloaded. Current
Mac staging/artifact is therefore not the delivered baseline. Rebuild deliberately
before the next install. Storage workers cannot perform DOM paint or native scrolling.

A long Paint/Composite instrumentation interval is not proof that bitmap drawing
itself consumed that CPU time: it can include waits in the rendering pipeline.
Do not present the timing as a full root-cause diagnosis. Native Instruments
investigation is now in progress. `xcrun xctrace list templates` works on the Mac
and includes Time Profiler, Animation Hitches, and System Trace. `devicectl device
info processes` finds Safari, WebContent, GPU, Userscripts, and AdGuard processes;
process presence alone does not establish which extension is active for Asura.

## Fresh-session recording checks

The user confirmed AdGuard was **off** during reproduction. Its loaded content
script and process do not override that observation or establish causation.
Safari was subsequently restarted. Always rediscover its page/process IDs.

The version 2 gesture collector refuses a hidden page, suppresses old Console
replays using the phone clock, and reports `COVERAGE` counts and dropped events.
It records trusted input, scroll commands, viewport changes and callback timing.
Synthetic `manga-inspector-sync` events are clock calibration only, never user
gestures. Match their native Timeline EventDispatch time to their probe
`performance.now()` time before correlating events; the clocks have different
origins. Event dispatch delay is not hardware touch latency. A delayed rAF
callback is not a count of dropped display frames.

Probe installation is scheduled outside the synchronous inspector evaluation;
the collector then verifies `window.__mangaGestureProbe.version === 2` before
printing `ARMED`. A short self-check must produce gesture batches, ScriptProfiler
updates, Timeline records and a calibration EventDispatch before asking for
physical reproduction. Do not announce readiness after a command timeout.
Verified fresh self-check: `.ios-debug/fresh-listener-check-7.jsonl` contains
4 gesture batches, 301 Timeline records, 312 ScriptProfiler updates, 2 calibration
dispatches and zero dropped probe events. `.ios-debug/fresh-native-check.jsonl`
contains 5 graphics and 10 process samples over five seconds. The subsequent
first coordinated recording failed to arm the web stream; do not analyze
`.ios-debug/fresh-scroll-web.jsonl` as a user trace. The native stream
`.ios-debug/fresh-scroll-native.jsonl` runs for 180 seconds. After minifying the
observer from 7,198 to 4,034 bytes with esbuild, self-check 8 also passed
(301 Timeline records, 312 JS updates, 2 sync dispatches, zero dropped events).
The retry `.ios-debug/fresh-scroll-web-2.jsonl` records 90 seconds within that
native interval. Minification passing does not yet prove the timeout cause.
Generate the compact observer locally with esbuild `transform(source,
{minify:true,target:"es2022"})`, copy it to the Mac as `gesture-probe.js`, and
retain the readable source here. No runtime bundle rebuild is involved.
The installed diagnostic bundle is still version 1 of the observer. For a
current-document version 2 test, stay in the open reader without reloading or
navigating; a fresh document would load the older diagnostic observer.

`tests/ios/native-metrics.py` adds native DVT Graphics and Sysmontap gauges through
the trusted Mac tunnel. Copy it alongside the collector and run with the same
Python and `--seconds 5` for a connectivity check. `NATIVE_COVERAGE` must show both
graphics and process samples. Graphics includes Core Animation FPS and device,
renderer and tiler utilization. These are devicewide aggregate gauges, not
per-frame CPU/GPU attribution. Process samples include Safari/WebKit CPU and
memory; null CPU values mean unavailable. The first native sample can be a
warmup/stale sample. `receivedEpoch` is the Mac receipt time, not the hardware
frame timestamp.

For coordinated recording, run both collectors with `--wait-for-start` pointing
at the same **new, nonexistent Mac file**, and the same `--seconds` duration.
Wait for both `READY_WAITING`, create that file on the Mac, then verify web
`ARMED` and native `NATIVE_STARTED` before inviting slow scrolling. Waiting is
bounded to 15 minutes; recording to five minutes. Keep one Web Inspector client
per tab. DVT gauges use a separate service and can run alongside it.

Native `xctrace` Time Profiler attempts from SSH and a GUI LaunchAgent ended
within about one second with `Device disconnected`; attaching the reported
Safari PID also failed. These traces are not usable sustained native CPU stacks.
The GUI diagnostic job was removed. Do not claim native stack attribution from
these failed attempts or from the aggregate DVT gauges.

The Mac has a one-minute idle sleep setting. A bounded `caffeinate -i -t 1800`
was used during attachment; no permanent power setting was changed. Signing
renewal remains deliberately paused while the Mac artifact differs from the
installed baseline. Restore a deliberately verified normal bundle and follow
REFRESH.md before resuming renewal.

## Fresh recording: reported jank, before disabling other extensions

The user reported jank in `.ios-debug/fresh-scroll-web-2.jsonl`. Final coverage:
11 accepted gesture batches, 5,397 Timeline records, 6,226 ScriptProfiler
updates, zero dropped probe events. Native coverage in
`.ios-debug/fresh-scroll-native.jsonl`: 179 graphics and 360 process samples.
These captures completed and the injected observer stopped. Do not tell the
user that this recording is still armed.

One trusted touch sequence was recorded, lasting about 122ms, followed by scroll
events until scrollend about 6.23 seconds after touchstart. Scroll position moved
from 676 to 2,422 CSS pixels. There were no captured programmatic scroll calls,
reader image loads, chapter additions, image style changes or history writes in
this reproduction. This is evidence about this gesture, not an exhaustive test
of all restore paths or sustained finger-down scrolling.

Clock alignment: the post-profiler calibration probe event at 687,121ms matches
Timeline EventDispatch at 1.145691958s. Thus subtract 685,975.308ms from probe
timestamps before comparing to Timeline seconds. The first calibration event
occurred before profiling started and has no matching Timeline dispatch. The
two native dispatch records at 1.14569s/1.14585s are from one synthetic event,
not two independent clock calibrations.

During the touchstart-to-scrollend interval, ScriptProfiler recorded 1,035
evaluations, maximum 0.750ms and sum 32.95ms. Five Paint records totalled 0.800ms,
maximum 0.207ms. Maximum Composite was 13.02ms. There were zero Layout records;
100 style recalculations totalled 13.87ms, maximum 0.324ms. These timings do not
show a long reader JavaScript callback or the previous long Paint interval.

Seven rAF callback gaps exceeded 25ms: maximum 46ms at touch onset, then 26–32ms.
The 45.77ms enclosing RenderingFrame at touch onset contains only brief measured
event dispatches, a 0.201ms rAF callback and a 0.199ms Composite; much of the
interval is outside those child records. It cannot be attributed to a long
JavaScript callback. Safari viewport height changed 781→821px at gesture onset.
This correlation does not prove browser toolbar animation caused the jank.

The full native graphics buckets during movement reported 59,59,60,59,59,60 FPS
and GPU device utilization 16–19%. The partial start/stop buckets were 8/17 FPS;
they include idle time and are not evidence of sustained 8/17 FPS scrolling.
Aggregate near-60 FPS does not exclude uneven individual frame presentation.

Observer overhead is present: unattributed/empty-script-name FunctionCall records
(principally the injected probe) totalled 56.67ms over the gesture, compared with
8.81ms for the recorded content.js callbacks. Callback durations include inspector
work and nested events; do not equate these sums with exclusive CPU time or claim
the instrumentation is free. No native thread stacks are available from this pass.
The precise cause of the reported jank remains unresolved.

Next controlled comparison requested by the user: manually disable every Safari
extension except Reader Extensions, then reload Asura to remove already-injected
scripts. Wait for the user to return to the reader; rediscover the page and arm
a fresh capture before asking for gestures. Do not silently toggle extensions,
install the local runtime candidate, or attribute loaded scripts to active filtering.

Keep traces/screenshots in ignored `.ios-debug/` locally and a private diagnostic
directory on the Mac. Never publish generated bundles: they embed the backup key.

The user confirmed other extensions disabled. The next capture armed successfully
on the freshly loaded visible Asura chapter 52 (document age ~31 seconds), probe
ID `1789121906934`. Files: `.ios-debug/reader-only-web.jsonl` and
`.ios-debug/reader-only-native.jsonl`, each bounded to 180 seconds. Before inviting
gestures, the web stream had 196 Timeline records and 3 probe batches; native
had 8 graphics and 14 process samples. This records the user-reported extension
configuration; script inventory has not independently verified every toggle.

## Confirmed takeover leak after other extensions were disabled

The user still felt lag in four gestures in the Reader-only recording. Final
coverage: 24 accepted probe batches, 10,807 Timeline records, 14,605 profiler
updates, zero dropped events; native coverage 179 graphics/360 process samples.
No programmatic scroll, reader image load, chapter append or image style-change
events were captured in those gestures. Callback gaps at each touch onset were
45/38/38/41ms. Paint maxima stayed below 0.17ms; Composite maxima per gesture were
7.47/7.50/8.46/9.28ms. First-gesture JS included a 12.386ms microtask; later gesture
maxima were below 1ms. This does not prove every hitch has the same cause.

Unlike the earlier pass, the first-gesture heavy work maps to Asura's own
`https://asurascans.com/_astro/ChapterReader.caKW6PzY.js`, line 2, column 5186.
Its public source was downloaded to ignored `.ios-debug/asura-chapter-reader.js`.
That function handles VisualViewport resize/scroll, reads viewport geometry,
and calls a React state setter. The reader booted at 1,704ms on this document,
versus 138ms in the earlier clean-start recording. Timing is observation, not
proof why Safari delivered the extension later. Native navigation metadata
reports `back_forward`, so this pass also exercises a history entry.

After the observer and profiling stopped, a read-only native listener inventory
(`.ios-debug/reader-only-listeners.jsonl`) verified:

- Probe absent, Manga Reader present, one chapter, zero script elements.
- Asura's exact viewport callback still registered for both `resize` and `scroll`.
- Window has Manga's settled-scroll listener **plus two Asura scroll listeners**:
  a React state/geometry updater and a 200ms position/localStorage saver.
- Document still has Asura/Astro/React listeners, including touchstart, keydown,
  selectionchange and Astro lifecycle events.

This is active original-site runtime after takeover, not merely loaded script
metadata or an AdGuard process. **Subsequent build-path inspection found the
direct migration defect:** `vite.config.ts` plugin `safari-document-takeover`
replaces the `document.open(); document.close();` lines from `src/core/shell.ts`
with `document.documentElement?.replaceChildren()` in extension mode. The phone
was therefore NOT testing the userscript's stop/open/close behavior. Do not
attribute the retained Window/Document listeners to SOC failing on this trace.
The substitution was introduced in commit `05777c1` (September 8). The extension
README says it avoided Safari reinjection during `document.close()`. Manga's
entry point already has a Window-lifetime guard set before takeover; whether
the guard alone handles Safari reinjection needs direct validation.

Separately, the HTML document-open algorithm reuses the Document and erases
listeners on its nodes and associated Window; VisualViewport is a separate
EventTarget. It does not create a fresh JavaScript realm or run React unmount
cleanup. Asynchronous site work can also remain and register listeners later;
the inventory alone cannot distinguish retained from re-registered Window listeners.
See [the normative document-open algorithm](https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#dom-document-open).

Treat takeover isolation as a correctness issue. A solution must prevent the
original runtime from starting on owned routes and address already-loaded/history
documents; removing a specific Asura callback is not a general cleanup strategy.
Any extension content-blocking design must preserve reader workers/API requests,
unowned routes, authentication/challenge flows and other packaged readers. Verify
on-device execution traces after reload/history restoration, not only empty DOM
or manifest `document_start` declarations. No takeover fix has been installed yet.

## Pure SOC experiment requested before considering guards

The user explicitly requires testing **unguarded** original SOC before alternatives.
All four local Vite defaults/transforms were restored toward SOC during the audit,
but only Manga is being built/installed for this experiment. The trial uses a
separate sibling checkout `.manga-pure-sop-jgbkjt3f`, HEAD runtime sources and the
current Vite config with its takeover substitution removed. Its extension entry
is only `import "../src/main"`, the original userscript startup. It contains no
extension boot guard and no gesture probe. Local reader/settle candidate fixes
are excluded. Build passed; verified actual output contains stop/open/close in
sequence and no `__mangaExtensionBoot` or `__mangaGestureProbe`.

Trial content SHA-256 `75df2186268462bc415b2f6a80802c5ad9cf9ef3f237cf41ebd71d3f42777b1f`.
Only Manga was staged, preserving the other three bundles. Xcode GUI build passed.
Previous Manga staging was copied to ignored `.ios-debug/staged-before-pure-sop`.
`tests/ios/observe-startup.py` records native debugger script events/errors around
an explicit reload without injecting any page listeners, timers, wrappers or guards.
The external collector timeout is not an application-side recursion guard. A
failed experiment is evidence for that exact mode, not universal impossibility.

First actual unguarded SOC run: installed successfully, build job finished/unloaded.
Native observer explicitly reloaded Asura (`.ios-debug/pure-sop-startup.jsonl`).
It recorded one new Manga content-script parse, no console errors, and final
state `guard:false, reader:true, chapters:1, scripts:0, errors:[]`. Document
readyState remained `loading`. No recursive startup was reproduced in this pass.
Repeated Safari internal ReaderShared/ReaderArticleFinder notifications had the
same script IDs and are not evidence of Manga reinjection. Further listener and
repeat-navigation checks are needed; this result contradicts treating pure SOC
as already demonstrated impossible. Other extensions remain unchanged.

Pure SOC listener audit after reload (`.ios-debug/pure-sop-listeners.jsonl`):
no boot guard or gesture probe; VisualViewport listeners empty; Window has one
reader scroll listener, one scrollend, one pagehide, one load and three pageshow;
Document has one visibilitychange listener. No Asura viewport/React scroll
callbacks remain in this inventory. Reader has one chapter and decoded image
geometry, CSS1Compat, 428px viewport, no errors. Native navigation metadata is
an actual reload. User corrected the abbreviation to SOC; existing private
filenames containing `sop` retain their original spelling for traceability.

Second successful pure SOC reload: `.ios-debug/pure-sop-startup-3.jsonl`, again
one new Manga content-script parse, no errors, no guard, one reader chapter and
zero script elements. The attempted collector in `pure-sop-startup-2.jsonl` failed
while attaching, before requesting reload; it is not an SOC failure. No recursion
has been reproduced by the two completed reload tests. History/cold-launch and
other readers are not yet verified. Local candidate restore/settle tests now pass:
46 tests plus TypeScript; these candidates remain excluded from the installed trial.
The next 180-second user scroll capture uses `pure-soc-scroll-web.jsonl` and
`pure-soc-scroll-native.jsonl`. The page observer attaches AFTER startup, so it
adds diagnostic overhead but no startup guard and does not alter the SOC sequence.

SOC scroll pass: user reported residual lag in two gestures. Timeline FunctionCall
sources were only the installed Manga content.js and the injected diagnostic
observer; no Asura script callback appeared. Gesture JS maxima were 0.780/0.369ms;
Paint maxima 0.224/0.186ms; Composite maxima 10.43/8.33ms; no Layout records.
Callback gaps remained (max 43ms, then 36ms at second touch onset). The 4.14ms
Manga callback at Timeline 26.671s was its 100ms settled-position timer AFTER the
first scrollend at 26.570s, not a callback during that gesture.

Collector operational caveat: SIGINT was sent after user completion to end the
long recording early. In this Python 3.9 collector it cancelled the receive task
before profiler cleanup; Timeline/ScriptProfiler stop responses timed out and
trackingComplete was not received. Do not use SIGINT for future normal stops;
use a cooperative stop marker or natural expiry. Observed events remain in the
log (17 accepted batches, 7,701 Timeline records, 9,190 JS updates, no dropped
probe events), but this pass lacks final sampled stacks. A premature follow-up
inspector attachment timed out; wait for the prior collector to exit fully before
reconnecting. This instrumentation error is not evidence of an SOC startup failure.

Post-scroll verification succeeded in `pure-soc-after-scroll-listeners-2.jsonl`:
visible reader, one chapter, no errors, zero script elements, no startup guard,
probe stopped/absent. VisualViewport listener inventory is empty. Window and
Document contain exactly the same reader lifecycle/settled-scroll callbacks as
before the gesture; the recorded function source matches the installed Manga
bundle. Native script enumeration contains Manga content.js, anonymous inspector
code, and Safari's QuickWebsiteSearchURLDetector/OpenSearchURLFinder helpers;
no Asura script is enumerated. Thus no evidence supports Asura returning during
this pass. Do not literally claim Safari runs no code except Manga: Safari's own
helpers and diagnostic code are distinct from original-site runtime. Residual
reported lag remains unexplained by this clean-page execution trace.

Added `observe-gestures.py --stop-file NEW_MAC_PATH` for future clean early
completion. It leaves the protocol receive loop alive while Timeline/ScriptProfiler
stop and probe cleanup finish. Copy the updated collector to the Mac before use;
this new option has not yet been exercised on-device. No reader behavior change.

## App comparison: gallery-downloader

Source audit of sibling `gallery-downloader` found the smooth iPhone app is
already a WKWebView hosting its bundled offline HTML/CSS/JS, not a UIKit image
list. `apps/ios/GalleryReader/WebController.swift` loads `gallery://app/`, permits
WebKit back/forward gestures, has no custom gesture recognizers and disables
automatic content inset adjustment. Swift GalleryStore/GalleryAPI actors handle
storage/networking; WKURLSchemeHandler supplies media to the web renderer.

The shared UI `gallery-server/downloader/public/offline/app.js` creates stable
aspect-ratio page slots, requests async image decoding, activates images within
1,000px of the reader viewport and removes src/revokes blob URLs outside that
window. Work queues prioritize visible requests and bound concurrency. Manga
currently relies on loading=lazy and retains loaded image sources.

GalleryStore.localResource calls ensureMedia for requested pages, so the existing
app can fetch an unsaved image on demand: its architecture already supports
online delivery, despite its offline-library purpose. The smallest useful app
comparison can reuse this shell/image lifecycle with an Asura chapter manifest
adapter rather than start with a new UIKit renderer. Compare identical Asura
image files; existing gallery images and long Asura strips are not equivalent
workloads. No source changes were made to gallery-downloader during this audit.

## Native Asura app and reading-list feed

The native app, optional PC history pipeline, build/deploy helper, and app-specific
inspector are documented in `../apps/ios/DEVELOPMENT.md`. Its fixed bundle ID is
`com.visar.AsuraReader`, with one application target and no extensions. It uses
`/Users/visar/Developer/asura-reader`, separate from both existing apps.

Historical automatic-feed build (superseded by manual Load/Save below):
The Asura feed publisher was worker-only. To preserve the installed pure-SOC trial
while adding the publisher, build the existing `.manga-pure-sop-jgbkjt3f` checkout
with only `src/core/compute/asura-reading-list.ts` and
`worker-entry.ts` copied from this repository. Its `extension/main.ts` remains
only the original main import (no guard/probe), and the local restore candidates
remain excluded. Stage only Manga with `stageBundle`; preserve the other three
staged readers byte-for-byte. Record delivered hashes and inspection below.

Verified publisher delivery: installed Manga content SHA-256
`2376895241b6902063dd7f1a8ba227e2d4aaa34eb2ad0154d1a70af5681c09f7`.
The other three extension bundles were preserved. Physical Safari inspection
recorded authenticated PUT 200 responses and 30 local Asura progress entries in
the PC feed. The native app consumed these automatically and wrote its own
30-entry reading backup. PC outages remain silent. Renewal remains paused for
the pre-existing experimental pure-SOC baseline; this deployment did not resume it.

The native reader's immediate `Invalid page dimensions` failure came from an
app-only validation: Asura chapter `the-extras-academy-survival-guide-53fc8424/123`
omits width/height on all 28 pages. The installed fix accepts missing dimensions
like the userscript, measures completed image files with native ImageIO, and
persists sizes for cached restores. A fresh app inspector session verified all
28 slots, loaded image dimensions, no errors, and only bundled reader scripts.
Use a new inspector attachment after navigation: the old target can stop
returning snapshots even though the navigation succeeded. Wait for its exit
before attaching again. See the app development document for parity and tests.

## Manual Load/Save delivery, 2026-09-11

This replaces the automatic reading-list feed and named Home backup workflow.
See `../apps/ios/DEVELOPMENT.md` for current semantics. Load/Save appears directly
below the loaded-series count only when the authenticated PC status endpoint
responds. Availability does not transfer reading history; only button clicks do.
Old publisher endpoint returns 410, and old snapshots stay on disk. No automatic
migration or first Save was performed during deployment.

For this extension delivery, the pure-SOC checkout kept its original startup.
Copy current `src/core/compute/worker-entry.ts`, `messages.ts`, `manual-pc.ts`,
`src/core/home-backup.ts`, `src/routes/home.ts`, `src/style.css`, and package.json
into that checkout. Remove obsolete asura-reading-list.ts, pc-backup.ts, and
backup-engine.ts there. Build from the checkout cwd, stage only Manga via
stageBundle, verify the other three readers' hashes, then use the standard
Reader Extensions GUI build/check/install/finish sequence. Runtime stays here.

Delivered extension content SHA-256:
`8090866dd356fe97793b375a14984183712001200902b6794897c9150f43c08d`.
Userscript rebuilt as version 285 at `dist/manga-reader.user.js` (private key
embedded; local distribution only). Native app installed with its existing ID.
Actual app inspector verified visible Load/Save below Loaded 343 of 343 series,
no errors. The live PC status endpoint returned 200 and opening Home did not
create a manual snapshot. Functional replacement/offline behavior is covered by
worker/UI/native/server tests, without using real reading state as a test fixture.

Physical Safari verification of this installed extension also showed Load/Save
below Loaded 343 of 343 series, visible with PC available and no page errors.
Home capture recorded only HTTP 200 to the manual status endpoint; no history
GET/PUT. Evidence: `.ios-debug/manual-extension-home.jsonl`,
`manual-extension-controls.jsonl`, and `manual-app-controls.jsonl`. Main repo's
ignored dist/extension now mirrors the exact delivered pure-SOC artifact; default
source builds still require the startup-baseline decisions documented above.

Asura app icon parity: removed CFBundleIcons and both custom PNG resource
entries/files to match Gallery Reader's no-custom-icon packaging. A clean Xcode
build removes stale bundled images. `xcodebuild clean` also removes the generated
`build/build.plist`; run deploy.py sync again after clean before GUI bootstrap.
Keep the same app ID/container when installing this update.

## Verified reader kill/relaunch fix

Before the fix, reading the real app container's state.json showed chapter 123,
page-123-1, fraction 0.09878883212038574, y=1500. SIGKILL + relaunch opened that
reader at y=0 and then saved the incorrect start position. A simple browser cold
launch fixture had passed; it did not model the bootstrap lifecycle save.

Ported Gallery's skipPositionSave gate during the Home-to-reader launch redirect,
held-anchor/animation-frame/ResizeObserver restoration with user-input release,
and one native view-save checkpoint. Keep Asura's existing fraction definition.
After installing the fix, the same physical SIGKILL + relaunch restored chapter
123 at y=1500 with 28 slots and no errors. Evidence in ignored
`.ios-debug/resume-fixed-before-kill.jsonl` and `resume-fixed-after-kill.jsonl`.
Browser and native checkpoint regression tests passed. No PC state transfer.

Read only the needed checkpoint fields when checking device state. The full
state.json contains private history/session data; keep diagnostic copies private.
`devicectl device copy from --domain-type appDataContainer --domain-identifier
com.visar.AsuraReader --source 'Library/Application Support/AsuraReader/state.json'`
can copy it to the Mac for inspection. Process listing JSON provides the exact
AsuraReader PID; terminate that PID with --kill, then launch the same bundle ID.
Only one Web Inspector collector may be attached at a time.

## Stream Viewer scrollend delivery, 2026-09-12

Stream Viewer commit `cca6e68`, version 261, restores the previous immediate
scrollend settlement and removes the 100ms position sampler. Userscript and
extension bundles were rebuilt in its source repository. The local Vite SOC
change remains uncommitted and is included in the extension artifact; its
XVideos takeover test still expects the older replacement behavior and fails.
Scroll, provider fixture, multi-video and cookie tests passed.

Verified the previous Mac signed artifact matched all four local staged bundles,
then staged only Stream Viewer (`npm run stage -- stream-viewer`). Standard
sync/build/status/install/finish completed successfully with the existing host
ID `com.visar.galleryreader.extensiontest`; all embedded hashes and the complete
signature passed before devicectl confirmed installation. Other staged readers
were preserved. Stream content SHA-256:
`fb73c7754f18fb24b76a3cb2014807a9ce569cef2a7b68606a07365c14725142`.

Reload the Safari page once before physical testing. No physical gesture
acceptance or post-install Safari runtime inspection was performed in this
delivery. Reader Extensions renewal was already unloaded before this work;
no active signing jobs were present. This deployment leaves that pre-existing
renewal state unchanged, pending its separate wireless/baseline workflow.
