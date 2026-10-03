# Six provider apps: paid native deployment

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

## Configuration and builds

Start with `/home/visar/Documents/environment/mac-access.md` for trusted SSH.
Ignored `deploy.local.json` selects paid team `65U58U86DD`, `bundleSuffix: .paid`,
GUI UID 501, and phone `00008101-000639912881401E`. The Mac mirror is
`/Users/visar/Developer/manga-reader/apps/ios` for every provider. Output example:
`build/asura.paid/Release-iphoneos/AsuraReader.app`.

Run from the manga-reader root, for each provider, one at a time:

```sh
python3 apps/ios/scripts/deploy.py sync asura
python3 apps/ios/scripts/deploy.py build asura
python3 apps/ios/scripts/deploy.py install asura
python3 apps/ios/scripts/deploy.py launch asura
```

The attached build enters GUI UID 501 with `sudo launchctl asuser`, immediately
drops back to that user, and supplies signing team, bundle suffix and device. It
creates no LaunchAgent; keep SSH attached until it reports BUILD SUCCEEDED. The
builder checks the built display name, provider, bundle identity, absence of icon
declarations, complete signature, profile team and phone inclusion. Installation
also checks every bundled web/native-resource hash. Signing locks prevent
overlapping builds. Omitting the suffix selects the registry's unsuffixed
identities; keep it when updating these installed apps.

All images and image links disable callouts, selection and dragging
(`-webkit-touch-callout: none`, `user-select: none`, `-webkit-user-drag: none` in
`src/style.css`); taps and scrolling are unchanged.

The six apps renew monthly through this repository's scheduler,
`com.visar.renewal.manga-reader`; see [renewal](../../../../ios-tools/renewal/PAID-REFRESH.md)
and its paid-signing lessons.
