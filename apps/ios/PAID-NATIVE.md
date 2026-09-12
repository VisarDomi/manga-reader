# Six provider apps: paid native deployment

Verified September 12, 2026: all six apps are installed directly on the iPhone
and each launched successfully. They coexist with Gallery Reader, Reader
Extensions, and the LC host. No LC-to-native data copy was performed: the user
requested a fresh start and the existing intentional PC Load/Save remains.

| Builder argument | iOS name | Paid native bundle ID |
| --- | --- | --- |
| asura | Asura | com.visar.AsuraReader.paid |
| scythe | Scythe | com.visar.ScytheReader.paid |
| yaksha | Yaksha | com.visar.YakshaReader.paid |
| qiscans | QiScans | com.visar.QiMangaReader.paid |
| lua | Lua | com.visar.LuaReader.paid |
| ezmanga | EzScans | com.visar.EzMangaReader.paid |

All use the same codebase and Xcode target. Names come from `src/core/sites.json`
→ `ios.displayName`, through `READER_DISPLAY_NAME` in the shared Info.plist.
There are no custom icon declarations, icon artwork or asset catalogs; iOS
supplies its standard fallback appearance. Internal product/data-directory names
remain the registry's existing values. Provider and PC namespaces are unchanged.

## Configuration and repeat builds

Start with `../../investigation/iphone-extension-debugging.md` for trusted SSH.
Ignored `deploy.local.json` selects paid team `65U58U86DD`, `bundleSuffix: .paid`,
GUI UID 501, and phone `00008101-000639912881401E`. The Mac mirror remains
`/Users/visar/Developer/asura-reader` for every provider; there are no separate
provider repos. Output example:
`build/asura.paid/Release-iphoneos/AsuraReader.app`.

Run from the manga-reader root, for each provider, one at a time:

```sh
python3 apps/ios/scripts/deploy.py sync asura
python3 apps/ios/scripts/deploy.py build asura
python3 apps/ios/scripts/deploy.py status asura
# Require no PID, LastExitStatus=0, and BUILD SUCCEEDED.
python3 apps/ios/scripts/deploy.py install asura
python3 apps/ios/scripts/deploy.py finish asura
python3 apps/ios/scripts/deploy.py launch asura
```

The GUI LaunchAgent supplies signing team, bundle suffix and device. The shared
builder checks the actual built display name, provider, bundle identity,
absence of icon declarations, complete signature, profile team and phone
inclusion. Installation additionally checks every bundled web/native-resource
hash. Existing signing locks prevent overlapping builds.

`npm run build:ios -- <provider>` remains the unsigned LC guest workflow.
Use the native commands above for the paid apps. Unsigned and paid outputs are
separate. Omitting the suffix selects the old registry identities; do not change
it when intending an update of these installed native apps.

## First-time registration, already completed on this Mac

Erdal's account is logged into Xcode. Its original wildcard profile excluded
this phone, so generic builds signed but could not install (`0xe8008012`).
Adding a destination to a target-only invocation did not register it. The
physical scheme was initially unavailable because Xcode reported missing iOS
26.2 platform support, despite the compiler/SDK working.

The user's Xcode Get-button download installed iOS 26.3.1 Universal Simulator.
After verification, the real phone became an available scheme destination.
Reader Extensions' physical scheme build registered it automatically using the
existing login. No further account-owner action was required. See
`../../../../reader-extensions/PAID-SIGNING.md` for that verified setup.

All six native profiles use team `65U58U86DD` and contain this phone. Initial
profiles expired September 12, 2027; current renewal deadlines are recorded in
the scheduler state described below. The existing target/SDK provider builds now work with
that enrolled profile. The paid batch now has a monthly renewal workflow; see
[monthly renewal](../../../../reader-extensions/PAID-REFRESH.md) for activation
status, verified tests and maintenance. The old individual Gallery/Reader Extensions/LC jobs remain disabled. One
installed-app scheduler handles all eight paid apps monthly, including Gallery.
The user deleted free Gallery and LC; their daily configurations are retired.

## Verification and cleanup

All six builds passed their identity/icon/signature/profile checks; their staged
resources matched before installation. The device's installed-app inventory
reported the exact six names above and `appClip: false`. All six native launches
succeeded. Gallery Reader and Reader Extensions remained installed, establishing
more than three simultaneous native development apps on this phone. LC also
remains installed. This is installation/launch verification; no new physical
scroll or reading-history acceptance test was performed for this batch.

Builder unit checks passed. Private evidence is in `.ios-debug/paid/batch.log`
and Mac `/Users/visar/Developer/paid-native-data/six-native-verification.json`.
The completed build jobs were unloaded. No library copies or native inspectors
were run during this batch.

Earlier cancelled Gallery copies and abandoned paid build/probe artifacts were
removed before this batch. Killing the old devicectl copy CLI had left its
transfer active inside CoreDeviceService; stopping the owning service and
verifying stable destination counts was required before deletion. The user
confirmed the fans stopped after cleanup. The broader idle/audio audit was
postponed; no driver or EFI change was made here. APNs work remains paused.
