# Shared Manga Reader refactor — build 7

The current task replaces the independent Swift providers and copied iOS UI
with imports of the userscript provider, Home, reader, retry, history and PC
backup modules. Native code is limited to networking, file storage/downloads,
WebKit hosting, navigation and lifecycle. Do not edit user-owned AGENTS.md,
readme.md or test.txt.

Required app additions: per-series previous/current/next downloads immediately
on Home and as reading moves, independent concurrent work with bounded transfers;
prune obsolete chapter downloads without deleting history; cold Home/reader
restore; First chapter; intentional PC Load/Save hidden when unavailable; existing
six identities/names and no icons.

Lua reproduction before refactor: phone last-read im-ready-for-divorce/chapter-4
stored total=4. The same live response yields 11 URLs in src/provider/lua.ts:
first four in src, remaining seven in data-src. Its regex matches both, while the
independent Swift parser only read src. No Swift parser patch was applied.
Private phone state and live HTML used for investigation must be removed at end.

Implementation plan:
- Bundle source routes/providers directly, with build-time platform adapters.
- Reuse source compute worker and history/PC logic; native adapter only changes
  the storage/network boundary, retaining the shared data format.
- App-specific coordinator plans download windows using shared provider results;
  native code stores opaque chapter metadata and bytes, never parses providers.
- No migration code. Use existing PC Save in each installed app before updating,
  then PC Load in each refactored app. Old extracted manifests must not be reused
  (Lua's are incomplete). Keep the standard shared backup format.
- Shared unit/provider checks and native file/queue tests; Lua real response and physical device restore/download validation.
- Build/install all six, approve delivered renewal baselines, restore existing
  monthly scheduler, verify no extra background items or caffeinate processes.

## Completed verification

All six paid apps were installed in place as build 7. Existing PC Save reported
Saved for all six before updating; Load reported Loaded afterward. Container
inspection confirmed every former current-position identity survived: Asura 31,
Scythe 5, Yaksha 1, QiScans 1, Lua 7, EzScans 9. Retired images/covers/manifests/list
caches were removed through device file access after that verification. The app
contains no old-AppState conversion or cleanup migration; old state.json remains
unused, and new shared storage is retained across subsequent updates.

Lua cover resume opened chapter 4 with 11 reader entries instead of 4. Its
previous/current/next chapters 3/4/5 each had all 11 local files (33 total) while
only two images were decoded in the visible reader. Killing/relaunching restored
chapter 4/image 0 at scrollY 2603, exactly matching the saved fractional position.
Returning through WebKit history restored Home's 618 cards and cover destination.
These are functional checks, not a claim of measured physical scroll smoothness.

Device testing also found the necessary native referrer adaptation (otherwise
Lua returned HTTP 403) and a shared-source Asura catalog bug: a real series had
no latest_chapters field. Asura now treats that catalog entry as having no
chapters. The correction and regression test live in the shared provider.

Validation: TypeScript check; 39 unit tests; provider/signing-lock builder tests;
Swift downloader/storage tests on the Mac. The three Chromium-only fixtures used
during delivery were subsequently removed at the user’s request. Runtime checks
target the physical iPhone and Safari/WebKit; do not reinstate those fixtures.
All six monthly renewal runs built/signed/installed successfully over USB with
history retained. Provider-specific generated Web assets are approved inputs;
building another provider does not invalidate another provider's approval.
Recovery receipt: environment/mac-renewal/manga-shared-codebase-verification.json.

Physical cover-resume smoke checks also opened current images in all six apps:
Asura 18, Scythe 6, Yaksha 9, QiScans 2, Lua 11 and EzScans 14 image entries, all
through the local downloader URL. EzScans' following chapter returned HTTP 200
with isFree=false, requiresPurchase=true and no images; the inherited reader
correctly displayed Chapter unavailable. No provider authentication was added.

The existing installed-app scheduler was restored and completed its installed-app
check successfully. No new LaunchAgent or background item was created. Temporary
phone-state copies, HTML captures and inspector probes were removed after the
sanitized receipt was recorded. AGENTS.md/readme.md/test.txt were not edited.
