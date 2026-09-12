# Standalone LiveContainer on the signing Mac

September 12 retirement: the user deleted LiveContainer from the phone after
migrating the readers to paid native apps. Its free daily renewal configuration
and job are retired. The instructions below are historical; do not restore LC
or its renewal implicitly. Current recovery: [environment setup](/home/visar/Documents/environment/mac-renewal/RECOVERY.md).

Shared Mac connection instructions: [mac-access.md](/home/visar/Documents/environment/mac-access.md).
Ethernet is now `192.168.1.198`; USB wireless remains DHCP.

Working setup for Visar's existing free development account. No SideStore,
AltStore, jailbreak, or daily guest provisioning. Gallery Reader remains a normal
installed app with its existing independent renewal job.

## Status

LiveContainer 3.8.0, certificate import, Asura guest reading/restore, and wireless
host renewal have passed on the real iPhone. The faster Shortcuts launch action
now has its LaunchAppExtension and ShareExtension installed with the verified
Apple-granted App Group. The certificate was reimported into shared settings;
Asura still restores (native inspection: y=748, 25 pages, no errors). A physical
Launch App is discoverable in Apple Shortcuts: a physical screenshot confirmed
the LC action and its Launch URL field on September 12. End-to-end fast launch
and final wireless renewal for this helper build are not yet recorded as passed;
the LC daily job has not been enabled yet.

See [investigation and device evidence](../../investigation/livecontainer-plan.md)
and [trusted SSH/iPhone runbook](../../investigation/iphone-extension-debugging.md).
Runtime comes from the pinned official IPA, not a modified LC source build.
The user's source reference remains `/home/visar/Documents/reference/LiveContainer`.

## Existing installation and refresh

Mac directory: `/Users/visar/Developer/livecontainer`.
Host ID: `com.kdt.livecontainer.AVQL5DLWLT`.
Guest: `com.visar.AsuraReader`, stored inside LC, not registered separately.
Signing identity is pinned to the existing certificate in `scripts/package.py`.
Do not create/revoke certificates or delete app containers to troubleshoot renewal.

Once enabled, `com.visar.livecontainer-refresh` uses the same runner as Gallery:
check every 600 seconds and at login; renew once 24 hours have elapsed since the
last successful install; retry while locked/unreachable. The Mac must be awake,
logged in, and able to reach the paired phone. It preserves data and uses the same
Mac advisory signing lock as Gallery. All launch helper profiles must be byte-for-
byte copies of the renewed host profile; LC-specific validation checks this.

Status on the Mac:

```bash
cd /Users/visar/Developer/livecontainer
python3 scripts/deploy.py status
tail -40 build/refresh/last-check.log
tail -40 build/refresh/build.log
```

`build/refresh/state.json` records actual successful installation and expiry, not
merely a timer firing. The package pins the signing certificate and refuses a
silently changed one. If the certificate eventually changes, deliberately update
the pin and import its matching identity into LC before approving a new baseline.

## Recreate deployment from this repository

Keep the existing Mac directory/private export and phone data. From Linux:

```bash
rsync -az --exclude=build --exclude=private --exclude='*.local.json' \
  -e 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/visar/Documents/hackingtosh/validation/macos-known-hosts' \
  apps/livecontainer/ visar@192.168.1.198:/Users/visar/Developer/livecontainer/
```

Before deliberately updating build inputs, check for a running LC refresh/build.
Wait for it to finish, then boot out only LC's refresh job. Preserve Gallery's job.
For manual builds check `pgrep -fl 'xcodebuild|refresh.py'` first; do not overlap
manual signing with scheduled signing.

On the Mac:

```bash
cd /Users/visar/Developer/livecontainer
python3 scripts/deploy.py prepare
```

This downloads the pinned official standalone IPA and creates an ignored local
refresh config only if missing. `package.py` verifies its SHA-256 before use.
For a different account/device, deliberately adapt the IDs/certificate/device in
the project, entitlement file and helpers. Never guess a new signing identity.

For the fast-launch build, the host must have
`group.com.kdt.livecontainer.AVQL5DLWLT` registered and assigned. Merely writing
that string into an entitlement file did not register it with Xcode's CLI.
In Xcode open `Provisioning.xcodeproj`, press Command-1, click the blue Provisioning
project at the top of the file navigator, choose LiveContainer under TARGETS,
then Signing & Capabilities → App Groups. Register the exact group using + and
select it. The packaging check rejects a profile with an empty group grant.

```bash
python3 scripts/deploy.py build
launchctl list com.visar.livecontainer-build
tail -30 build/build.log
```

Build runs asynchronously in the logged-in GUI session for Keychain access.
Wait until the job has no PID, exits 0, and logs successful signing/verification.
The tiny provisioning stub is only used to obtain the profile. The installer
deploys the official LC runtime, with its launch helpers signed using that main
profile. This avoids registering two additional helper App IDs. LiveProcess
multitasking is not included.

```bash
python3 scripts/deploy.py install
python3 scripts/deploy.py export-identity
```

Export reuses existing private files. On first export, approve the Mac Keychain
prompt for the selected Apple Development identity. If `-25320` occurs, wake the
Mac display (`caffeinate -u -t 10`) and retry. Password/P12 stay in the Mac's mode-
0700 `private` directory with mode-0600 files. Never print, commit, upload or copy
them into shared deployment resources. Open LC's own UI before certificate import:

```bash
python3 scripts/deploy.py import-certificate
```

On the phone run Settings → JIT-Less Mode Diagnose → Test JIT-Less Mode. Confirm it
passes. After adding the App Group, reimport the same identity: LC now reads its
shared preferences rather than the initial `Unknown` suite. Asura's existing
private data remains in its existing guest container.

## Add or update a guest app

Build the provider's native `.app` on the Mac as usual, then:

```bash
python3 scripts/deploy.py import-app /Users/visar/Developer/asura-reader/build/asura/Release-iphoneos/AsuraReader.app
python3 scripts/deploy.py launch-asura
```

The helper packages the built app, copies it into LC's Documents using the paired
device connection, and invokes LC's normal install URL. For an update, choose the
existing app/container in LC's replacement prompt. Do not create a new container
or uninstall the old guest. Manual PC Load/Save remains intentional; setup does
not automatically replace history from a PC snapshot.

## Approve and enable daily wireless renewal

After reviewing the installed build, unplug USB and leave the phone unlocked on
Wi-Fi. Run:

```bash
python3 scripts/deploy.py approve
python3 scripts/deploy.py renew-wireless
launchctl list com.visar.livecontainer-renew
tail -40 build/renew.log
```

Require `Connection: localNetwork`, later profile expiry, exit 0 and successful
installation. Open Asura and check retained state. Only then:

```bash
python3 scripts/deploy.py enable-renewal
python3 scripts/deploy.py status
```

The installer refuses to enable the job without recorded wireless success and
unchanged approved inputs. If deliberate source changes are made later, install
and review those changes before approving their new fingerprint.

## Home Screen launch flow

The [official guide](https://livecontainer.github.io/docs/guides/add-to-home-screen)
supports both an Open URLs shortcut and a faster LC Launch App action. In pinned
3.8.0 the helper called "LaunchAppExtensionHelper" in the guide is implemented by
ShareExtension; the source explicitly requires LaunchAppExtension + ShareExtension.

Use this exact flow for each reader:

1. Hold the reader in LC → Add to Home Screen → Copy Launch URL. If multiple
   containers exist, select the intended one first so its URL preserves that choice.
2. Open Apple Shortcuts → + → search **Launch App** → choose **LiveContainer's**
   action (LC's icon), rather than Apple's generic Open App action.
3. In the action card, tap the gray **Launch URL on the right**, paste the copied
   URL, and dismiss the keyboard. Tap the **▶ at bottom-right** to test it.
4. Verify the intended reader opens and restores its state. Return to the shortcut
   editor, rename the shortcut, then Share (square/up arrow) → Add to Home Screen.
5. Duplicate the shortcut for the remaining readers and replace the launch URL
   using each one's Copy Launch URL. Test each before adding its Home Screen icon.

The six current products are AsuraReader, ScytheReader, EzMangaReader,
QiMangaReader, LuaReader and YakshaReader. The basic URL for each is
`livecontainer://livecontainer-launch?bundle-name=com.visar.<Product>.app`;
prefer LC's copied URL when it includes a selected container. This action uses
the installed launch helpers to bypass the LC UI. Upstream estimates about 1–2
seconds saved per launch; that is not a measured result on this phone. Open URLs
and Create App Clip are different launch paths and do not select this fast action.

September 12 clarification: the user's six old Home Screen entries were made
with LC's **Create App Clip**, not Apple Shortcuts. The user is deleting those
entries. All six guests now contain manually loaded reading history: preserve
their LC containers. Replace the entries with Apple's Shortcuts **Launch App**
action, then Add to Home Screen from that shortcut's share menu. Do not create
more App Clips or substitute Open URLs.

The Hackintosh's `shortcuts sign --mode anyone` currently fails with “In order
to do this, you must be signed into iCloud.” Its Shortcuts list is empty. A
generated unsigned file is not a delivered/importable shortcut; no shortcut
was created on the phone by that signing attempt. Do not configure the user's
iCloud account just to avoid the editor. Native inspection can capture the
phone screen, but its simulated editor taps did not work in earlier checks.
Create/test the first action on the phone, then duplicate it for each provider.
The host and its two launch helpers already exist; no LC rebuild is needed for
this step. Physical fast-launch acceptance remains pending.

Read-only launch diagnostics can copy the shared preferences using devicectl's
`appGroupDataContainer` domain, identifier `group.com.kdt.livecontainer.AVQL5DLWLT`,
source `Library/Preferences/group.com.kdt.livecontainer.AVQL5DLWLT.plist`.
Use a private temporary file and print only `LCLaunchExtensionScheme`,
`LCLaunchExtensionBundleID`, `LCLaunchExtensionContainerName`, and
`LCLaunchExtensionLaunchDate`, plus a boolean for the private-Documents bookmark.
Never print the entire preferences dictionary: it holds signing credentials.
Before the first fast-shortcut test, the bookmark was present and the four
launch fields were absent. LC consumes some launch fields during bootstrap;
their later absence alone is not failure evidence.

Later readback showed a launch request for `com.visar.AsuraReader.app`, scheme
`livecontainer`, and its original container `5B055983-441F-45CA-979E-CAFC27788B94`,
with device timestamp `2026-09-12 14:49:21.944323`. This establishes that launch
parameters were written; it is not a timed cold-launch measurement or proof that
all six Home Screen shortcuts were completed. Keep those evidence levels distinct.

The earlier Reader Extensions guest experiment was superseded by the user's
request to install it normally. Its Safari extensions are separate from LC's own
installed launch helpers. No claim was made that guest Safari extensions work.

## Second guest and normal extension app — September 11

Reader Extensions was reinstalled normally as `Reader Extensions.app`, bundle ID
`com.visar.galleryreader.extensiontest`. Its embedded web hashes and full signature
matched staging. Gallery remains untouched. The current three native hosts are
Gallery Reader, LiveContainer, and Reader Extensions; Scythe is an LC guest.

Historical September 11 implementation used a Scythe provider target (replaced
on September 12 by one target and a required provider builder). See
[provider app development](../ios/DEVELOPMENT.md#livecontainer-guest-builds).
Its unsigned iPhone build and native/browser tests passed, including a real Scythe
catalog (63 series), chapter list (907 chapters), manifest (7 pages), and image
transfer. Scythe was imported using LC's normal IPA installer and verified on
the phone: Home showed 63 cards; chapter 907 opened with 7 pages and no errors.
After saving y=1200, terminating LC, and relaunching Scythe, native inspection
showed the same chapter at y=1200 with loaded images and no errors. This is a
functional programmatic restore test, not a claim about physical scroll feel.
The user is away and explicitly requested stopping whenever a manual step arises.

When a guest is running, LC rejects install URLs with “Please restart LiveContainer
to install apps.” The verified unattended route is `deploy.py open-ui` before
`deploy.py import-app ...`: this restarts the host into its own UI, preserving
existing guest data. Do not mistake devicectl's successful URL dispatch for a
successful import. Verify the guest's LCAppInfo.plist in Documents/Applications
and then its actual reader page. `launch-scythe` opens the new guest.
