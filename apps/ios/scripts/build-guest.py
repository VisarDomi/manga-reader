#!/usr/bin/env python3
"""Build one provider with the common iOS target; unsigned unless a team is supplied."""
import argparse, fcntl, json, os, pathlib, plistlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('provider')
    args = parser.parse_args()
    registry_file = ROOT / 'build/providers.json'
    if not registry_file.exists():
        parser.error('Missing generated registry. Run npm run build:ios -- <provider> --prepare-only, then sync.')
    registry = json.loads(registry_file.read_text())
    if args.provider not in registry:
        parser.error('Unsupported iOS provider: ' + args.provider)
    provider = registry[args.provider]
    output = ROOT / 'build' / args.provider
    output.mkdir(parents=True, exist_ok=True)
    settings = {
        'PRODUCT_NAME': provider['productName'],
        'PRODUCT_BUNDLE_IDENTIFIER': provider['bundleIdentifier'],
        'READER_PROVIDER': provider['key'],
        'READER_DISPLAY_NAME': provider['displayName'],
        'SWIFT_ACTIVE_COMPILATION_CONDITIONS': '$(inherited) READER_' + args.provider.upper(),
        'EXCLUDED_SOURCE_FILE_NAMES': ' '.join(p['source'] for name, p in registry.items() if name != args.provider),
    }
    config = output / 'Provider.xcconfig'
    config.write_text(''.join(f'{key} = {value}\n' for key, value in settings.items()))
    cache = pathlib.Path.home() / 'Library/Caches/ios-app-refresh'
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / 'signing.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise SystemExit('Another app is building/signing; retry after it finishes')
        if subprocess.run(['pgrep', '-x', 'xcodebuild'], stdout=subprocess.DEVNULL).returncode == 0:
            raise SystemExit('An Xcode build is running; retry after it finishes')
        team = os.environ.get('DEVELOPMENT_TEAM', '')
        signing = ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'DEVELOPMENT_TEAM=' + team] if team else ['CODE_SIGNING_ALLOWED=NO']
        subprocess.run(['xcodebuild', '-project', str(ROOT / 'AsuraReader.xcodeproj'), '-target', 'Reader',
                        '-xcconfig', str(config), '-sdk', 'iphoneos', '-configuration', 'Release',
                        'SYMROOT=' + str(output), *signing, 'build'], check=True, cwd=ROOT)
    app = output / 'Release-iphoneos' / (provider['productName'] + '.app')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    for key, value in [('CFBundleIdentifier', provider['bundleIdentifier']), ('CFBundleName', provider['productName']), ('ReaderProvider', provider['key'])]:
        if info.get(key) != value: raise SystemExit('Built app identity mismatch: ' + key)
    print('Verified provider app: ' + str(app))

if __name__ == '__main__': main()
