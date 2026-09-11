# Standalone LiveContainer on the signing Mac

Working setup for Visar's existing free development account. No SideStore,
AltStore, jailbreak, or daily guest provisioning. Gallery Reader remains a normal
installed app with its existing independent renewal job.

## Status

LiveContainer 3.8.0, certificate import, Asura guest reading/restore, and wireless
host renewal have passed on the real iPhone. The faster Shortcuts launch action
now has its LaunchAppExtension and ShareExtension installed with the verified
Apple-granted App Group. The certificate was reimported into shared settings;
Asura still restores (native inspection: y=748, 25 pages, no errors). A physical
Launch App shortcut test and final wireless renewal for this helper build remain
pending; the LC daily job has not been enabled yet.

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
  apps/livecontainer/ visar@192.168.1.46:/Users/visar/Developer/livecontainer/
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
python3 scripts/deploy.py import-app /Users/visar/Developer/asura-reader/build/Release-iphoneos/AsuraReader.app
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

After the fast-launch action is verified: hold Asura in LC → Add to Home Screen →
Copy Launch URL. In Apple Shortcuts create a shortcut with LC's **Launch App**
action, paste that URL, run it once, then Share → Add to Home Screen. Name it
Asura; use the desired saved icon or a plain shortcut icon. Duplicate the shortcut
and replace its URL for later providers. The basic **Open URLs** shortcut remains
available when LC's launch helpers are absent.

The earlier Reader Extensions guest experiment was superseded by the user's
request to install it normally. Its Safari extensions are separate from LC's own
installed launch helpers. No claim was made that guest Safari extensions work.

## Second guest and normal extension app — September 11

Reader Extensions was reinstalled normally as `Reader Extensions.app`, bundle ID
`com.visar.galleryreader.extensiontest`. Its embedded web hashes and full signature
matched staging. Gallery remains untouched. The current three native hosts are
Gallery Reader, LiveContainer, and Reader Extensions; Scythe is an LC guest.

The shared reader now has a Scythe provider target. See
[provider app development](../ios/DEVELOPMENT.md#livecontainer-guest-builds-asura-and-scythe).
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
