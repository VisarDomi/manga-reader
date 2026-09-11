# LiveContainer with existing Mac renewal

Investigated 2026-09-11. The user selected standalone LC and authorized setup,
Asura first, followed by a real Reader Extensions guest experiment. Gallery stays
installed and unchanged. LiveContainer 3.8.0 is now installed and launches; Asura
is imported and user-tested, including reader restore. Initial wireless renewal
passed. The user subsequently requested LC's faster Home Screen launch helpers;
both helpers are now installed with a verified App Group. The physical Shortcut
test and final wireless renewal/daily-job activation remain pending.

## Decision supported by the investigation

Recommend standalone LiveContainer with the existing Mac renewal mechanism.
SideStore is not intrinsically required by the guest signing/launch path. Its
documented installer/certificate/renewal integration supplies functions we can
provide from the Mac instead. This is a custom deployment path, not a claim that
the official AltStore/SideStore installation guide was followed.

There are two separate signing responsibilities:

1. Xcode provisions/signs the outer LiveContainer app. The Mac renews that app's
   seven-day profile and installs an update preserving its identity and data.
2. LiveContainer imports the corresponding signing identity (certificate **and
   private key**, in a password-protected P12), then signs guest code using its
   bundled ZSign library. Guest apps are loaded inside LC, not registered as
   separately installed iOS apps. Guest signing does not request individual
   provisioning profiles from Apple.

The existing renewal runner can supply the first responsibility through a separate
LC configuration/build command. The second already exists in LC. Do not create a
separate daily Xcode provisioning job for every guest. A changed/expired/revoked
signing identity requires updating LC's imported identity; ordinary profile
renewal and certificate replacement are different events. Keep the host on the
same certificate, not merely the same team, and validate this during renewal.

## Source evidence

Use the user's reference checkout, without modifying it:
`/home/visar/Documents/reference/LiveContainer`.
Inspected HEAD `3afa9eb9a53625e9b8bd8b932e5785fd716ad5ae` (clean).
Stable release 3.8.0 is tag commit
`e370a92dfc03ce109ebce00ed4a7cfc64ad1c801`, published July 17, 2026.
Compared the relevant signing/import files against that tag; the manual import
and bundled signer paths exist there too. Pin a release for deployment and record
any build configuration changes separately from the reference checkout.

- `LiveContainerSwiftUI/Views/Settings/LCSettingsView.swift`: Settings exposes
  manual certificate import independently of Store detection. `importCertificate`
  reads a P12, checks that it can extract a team ID, and persists it plus password.
  `importCertificateFromSideStore` is a separate optional path.
- `LiveContainerSwiftUI/Utilities/LCUtils.m`: `signAppBundleWithZSign` loads bundled
  `Frameworks/ZSign.dylib` and passes host bundle ID, imported certificate and
  password. Despite the helper name `loadStoreFrameworksWithError2`, it does not
  load a framework from an installed Store.
- `ZSign/zsign.mm`: `signWithAppPath` enumerates guest Mach-O files;
  `signMachOPathArr` initializes the signing asset with certificate/password and
  no provisioning-profile input. It performs local code signing.
- `LiveContainerSwiftUI/Models/LCAppInfo.m`: checks guest code validity through
  iOS; when necessary signs it locally and checks again. Do not promise guests
  never need re-signing or invent a weekly per-guest renewal requirement.
- `LiveContainer/LCSharedUtils.m`: App Group lookup tries Store-named groups,
  then a cached group, then the app's actual signed App Group entitlement. An
  installed Store is not required to resolve a valid group.
- `LiveContainerSwiftUI/Views/Settings/LCJITLessDiagnoseView.swift`: checks identity,
  `get-task-allow`, App Group access and the 128 explicit LC keychain groups.
  `LCUtils.validateJITLessSetupWithCompletionHandler` signs a test dylib and asks
  iOS to validate its code signature.

Official references:

- [Project/build instructions and limitations](https://github.com/LiveContainer/LiveContainer)
- [Standalone installation](https://livecontainer.github.io/docs/installation/standalone)
- [Signing diagnostics, including file certificate import](https://livecontainer.github.io/docs/faq/jit-less-mode-setup)
- [Combined package: one installed app slot](https://livecontainer.github.io/docs/installation/lc_sidestore)
- [Stable 3.8.0](https://github.com/LiveContainer/LiveContainer/releases/tag/3.8.0)

## Existing environment verified

Use the SSH trust options in [the iPhone runbook](iphone-extension-debugging.md).
Mac: `visar@192.168.1.46`, Xcode 26.3. Phone: iPhone 12 Pro Max, iOS 26.6.2,
Developer Mode enabled. This investigation's device connection was wired;
do not count it as a new wireless validation.

Device app inventory confirmed Gallery Reader (`com.visar.GalleryReader`) remains
installed. Asura Reader and Reader Extensions are absent, as the user reported.
LC and SideStore are absent. Gallery must remain installed and unchanged during
this setup.

`com.visar.gallery-reader-refresh` is loaded on the Mac and reported last exit 0.
Its policy and runner are in the sibling `gallery-downloader/apps/ios/REFRESH.md`
and `apps/ios/scripts/refresh.py`: 600-second checks, renewal due after 24 hours,
shared signing lock, refresh exact profiles, validate advanced expiry, then
install without uninstalling or resetting data. Reader Extensions renewal is
currently not loaded. Do not alter Gallery's job or its unrelated working changes.

The cached Asura profile has `get-task-allow=true` and a team-wildcard keychain
grant but no App Group grant. It expires September 18, 2026. It is not an LC
profile and cannot simply be substituted. No App Group-bearing profiles were
found in the inspected current Xcode profile-cache/Reader Extensions build paths;
this does not establish that this team cannot provision an App Group.

LC's own entitlement template includes App Groups, 128 keychain groups,
HealthKit-related capabilities and increased-memory-limit. Preserve and validate
LC's requirements explicitly; do not blindly use Asura's minimal signing settings
or assume Xcode Personal Team will accept every capability without a test.

## Proposed installation layout and next verification

The three normal installed-app slots can be Gallery Reader, standalone LC, and
Reader Extensions. Asura and subsequent provider apps live inside LC. Two free
slots are sufficient. Reader Extensions must remain outside LC because guest
Safari extensions cannot register with iOS. LC's own optional extensions are a
different matter: they can consume extra App IDs, although not separate host-app
slots. Inspect the selected build's targets before registering IDs; initially we
need one reader at a time, not LC multitasking. Do not assume deleting apps frees
their registered App IDs immediately.

After alignment, validate standalone LC first:

1. Provision/sign the pinned LC build using the existing Mac identity, with its
   required entitlements and stable host/group IDs. Validate profile grants and
   actual signed entitlements. Do not revoke certificates used by Gallery.
2. Install LC and securely import only its matching signing identity. Keep P12s,
   passwords and profiles out of Git/logs. No identity export was done during this
   investigation.
3. Pass LC's JIT-less diagnostic on the real phone. For the private-storage mode
   selected below, an unavailable App Group is expected, not a signing success.
   No jailbreak, SideStore or per-launch JIT service should be needed for this path.
4. Import Asura's IPA and test home, on-demand/cached images, manual PC Load/Save,
   reader scrolling and kill/relaunch progress. Its source uses a WKWebView and
   normal app storage, with no app extensions or special entitlement dependency;
   this makes it a candidate, not proven compatible. Adapt inspector selection to
   LC's actual host process rather than assuming `com.visar.AsuraReader` is installed.
5. Perform an actual wireless host renewal, confirm advanced expiry, retained LC
   guest data/certificate, and successful Asura launch afterward. Then configure
   LC's own daily job using the established renewal mechanism and shared lock.

If a step fails, record the specific provisioning/launch error and investigate it.
Failure of a generic Xcode configuration is not evidence that SideStore is needed.
Do not switch to SideStore automatically. The combined LC+SideStore package is
available as a one-slot alternative only if the user selects it after findings.

LC guests share host permissions and are not security-sandboxed from each other;
use this container for the user's reader apps. Future migration of Gallery is a
separate decision, including its background behavior and data preservation.

## Setup findings and reproducible packaging

Local deployment files: `apps/livecontainer`. Mac mirror:
`/Users/visar/Developer/livecontainer`. The user's reference checkout is unchanged.
The package script verifies the official 3.8.0 IPA SHA-256
`b6fea95e30083382e29ffef88fa1aaa40b5069e1112e5307d490dab04648bba6`.
It preserves upstream runtime binaries, changes the host bundle ID, removes the
three optional LC host extensions, and signs with the Xcode-generated profile.
Host ID: `com.kdt.livecontainer.AVQL5DLWLT`. Only this new host ID is provisioned.
The tiny `Provisioning` app exists to obtain the profile; it is never installed.

Use `xcodebuild -target LiveContainer -sdk iphoneos`, as in the existing native
app flow. `-scheme ... -destination generic/platform=iOS` incorrectly rejected
the installed iOS 26.2 platform on this Mac; target builds succeeded.

The first Xcode request rejected HealthKit Access (Verifiable Health Records).
Removed `com.apple.developer.healthkit.access` from the requested entitlement
file; retained base HealthKit, background delivery and increased memory limit.
Xcode then issued a profile but left the requested App Group list empty. Adding
the Xcode capability attribute and requesting a fresh exact-host profile did not
assign the group. Do not interpret this as a requirement to install SideStore.

Correction to the initial blanket App Group requirement: upstream `Shared.swift`
already falls back to the app's own Documents directory when no shared group
exists. Its Settings/certificate code uses the `Unknown` preferences suite in
this configuration. The release notes distinguish shared/multitasking features
from ordinary guest loading. The deployed package therefore requests no App Group
and includes no optional host extensions. This uses upstream behavior without
runtime patches. Its 128 keychain groups and `get-task-allow` are preserved.
The absence of App Group access will remain visible in Diagnose.

The existing development identity is pinned in packaging. A successful profile
was issued expiring 2026-09-18 12:49:04 UTC, and the resulting full LC package
passed strict signature validation and installed successfully. No certificate
was created or revoked. `export-identity.swift` exports only that selected
identity to mode-0600 files in a mode-0700 Mac `private` directory. Initial export
failed with `-25320` (dark wake); `caffeinate -u -t 10` allowed the GUI Keychain
prompt, and the user approved it with Always Allow. Export then succeeded.
Do not recompile/re-export needlessly or request approval again for that action.

The existing LC certificate URL callback imported the identity; construct its
URL only in local Python and suppress subprocess output so signing material
never appears in tool logs. The P12/password remain private on the Mac.
Asura's existing built bundle was packaged as an IPA, copied into LC Documents
with `devicectl device copy to`, and imported using LC's normal install URL.
Installed guest folder: `Documents/Applications/com.visar.AsuraReader.app`.
Do not enable `--remove-existing-content` when copying into app containers.

`scripts/native-ui.py` uses pymobiledevice3 AccessibilityAudit to read focused
elements and DVT Screenshot to capture the physical screen. Read-only inspection
works. Its `perform_press` command was accepted but did not activate Settings on
this phone; do not report a press as completed without checking the resulting UI.
The user is performing the JIT-less diagnostic tap. Native Asura web inspection
accepts `--host-bundle com.kdt.livecontainer.AVQL5DLWLT` in addition to the original
Asura bundle ID, because guest bundle reporting can differ from host identity.

Renewal preparation copies the existing stdlib runner and installer into LC's
own directory, with a separate `com.visar.livecontainer-refresh` template/config.
The runner retains the same shared Mac signing lock. No LC daily job has been
enabled yet: first complete guest launch and an actual wireless host renewal.

The user reported JIT-less Test Passed, then tested Asura and restore successfully.
Native Web Inspector independently saw chapter 52, y=748, 25 page slots, loaded
images and no page errors, inside the LC-hosted app. The first wireless renewal
reported `Connection: localNetwork` and advanced the host's expiry from
2026-09-18 12:49:04 to 13:07:13 UTC. After reinstall, Asura retained its chapter,
anchor, y=748 and history; the only progress-record change was `updatedAt` from
the resumed app. LC retained the identical P12. The user confirmed wireless
update worked and reconnected USB.

## Faster Home Screen launch upgrade (in progress)

The user selected LC's faster Launch App shortcut action. The official guide
mentions LaunchAppExtensionHelper; the actual pinned 3.8.0 code and archive use
**LaunchAppExtension + ShareExtension**. Keep both. LiveProcess is not needed for
this reader-launch flow. An accessible App Group is now required to share the
launch selection and the private Documents bookmark. LC creates that bookmark
in `LCTabView.checkPrivateContainerBookmark` when its UI initializes.

Existing unexpired cached profiles already cover ten unique App IDs. Follow
LC's supported main-profile packaging instead of registering new helper IDs.
Inspected official Impactor source at
`e53e43182998e6717fe81dc6c1f578ac74234130`: LC defaults `embedding.single_profile`
to true; only the main bundle is registered, other bundles reuse that profile.
`merge_entitlements` preserves its explicit application-identifier while fixing
keychain group prefixes. Our packaging keeps distinct helper Info.plist IDs
under the LC host but signs them with the exact main profile/entitlements.
The LC renewal adapter checks both helpers' names, Info.plist IDs and identical
profile bytes before treating them as one renewal deadline. Five regression
tests cover valid copies, stale/missing/unexpected helpers and a wrong bundle ID.

The user removed/re-added the App Group in Xcode. The resulting Apple profile
`12477848-6f3c-4571-9ae9-ec3e7ffc7dd4` now grants
`group.com.kdt.livecontainer.AVQL5DLWLT`, expiry 2026-09-18 13:21:31 UTC.
The Xcode project was pulled back into this repository. Both helpers were
signed with the exact same host profile and installed successfully on the phone.
The existing certificate was reimported into shared settings. Native inspection
after launching Asura again showed its saved chapter, y=748, 25 pages, loaded
images, and no errors. This does not yet prove the Shortcuts action works.

Mac UI tooling limitations verified here: `osascript` UI access was denied by
macOS Accessibility; remote `screencapture` only returned menu bar/black desktop.
Do not pretend those captures show Xcode. The user pressed Shift-Command-3;
reading the resulting Desktop PNG showed the actual UI. The first capture showed
`Provisioning/main` selected. Click the **top Provisioning project row** directly
above it (x≈100,y≈112 on that 1920×1080 screen) to reveal project/target settings.
Inspect a new user-created Desktop capture when the UI differs rather than
repeating assumed directions.

## Provider apps and third native slot

The user requested Scythe as a second LC guest with identical shared reader UI,
restore, download policy, and manual PC Load/Save. Native provider adapters now
separate Asura API data from Scythe HTML data; the shared reader does not render
remote site HTML/scripts. Tests and the Scythe iPhone build passed. Import succeeded after restarting
LC into its own UI (a guest cannot install another guest). Phone inspection
showed 63 Home cards, then chapter 907 with 7 pages and no errors. Saving y=1200,
terminating LC and relaunching Scythe restored the reader to y=1200. Subjective
physical scroll testing remains for the user.

Reader Extensions is now installed as a **normal app**, at the user's explicit
request, named Reader Extensions with its existing ID. This supersedes the earlier
plan to try its Safari extensions inside LC. Gallery was not changed.

The user is away from the PC and asked to stop and wait if any manual setup is
needed. Do not infer confirmation from time passing. Resume physical Shortcuts/
wireless tests with the user; do not mark the final helper renewal verified or
activate the daily job against an untested helper build.
