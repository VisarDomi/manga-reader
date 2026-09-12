#!/usr/bin/env python3
"""Build one provider with the common iOS target; unsigned unless a team is supplied."""
import argparse, contextlib, fcntl, json, os, pathlib, plistlib, re, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]

@contextlib.contextmanager
def signing_lock(path):
    inherited = os.environ.get('IOS_REFRESH_LOCK_FD')
    if inherited is not None:
        # The monthly runner owns this same open-file lock through build/install.
        fd = int(inherited)
        actual, expected = os.fstat(fd), path.stat()
        if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise SystemExit('Inherited signing lock does not match the shared lock file')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    else:
        with path.open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise SystemExit('Another app is building/signing; retry after it finishes')
            yield

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
    suffix = os.environ.get('READER_BUNDLE_SUFFIX', '')
    if suffix and not re.fullmatch(r'\.[A-Za-z0-9-]+', suffix):
        parser.error('READER_BUNDLE_SUFFIX must be one dotted bundle component, e.g. .paid')
    bundle_id = provider['bundleIdentifier'] + suffix
    output = ROOT / 'build' / (args.provider + suffix)
    output.mkdir(parents=True, exist_ok=True)
    settings = {
        'PRODUCT_NAME': provider['productName'],
        'PRODUCT_BUNDLE_IDENTIFIER': bundle_id,
        'READER_PROVIDER': provider['key'],
        'READER_DISPLAY_NAME': provider['displayName'],
        'SWIFT_ACTIVE_COMPILATION_CONDITIONS': '$(inherited) READER_' + args.provider.upper(),
        'EXCLUDED_SOURCE_FILE_NAMES': ' '.join(sorted({p['source'] for p in registry.values()} - {provider['source']})),
    }
    config = output / 'Provider.xcconfig'
    config.write_text(''.join(f'{key} = {value}\n' for key, value in settings.items()))
    cache = pathlib.Path.home() / 'Library/Caches/ios-app-refresh'
    cache.mkdir(parents=True, exist_ok=True)
    with signing_lock(cache / 'signing.lock'):
        if subprocess.run(['pgrep', '-x', 'xcodebuild'], stdout=subprocess.DEVNULL).returncode == 0:
            raise SystemExit('An Xcode build is running; retry after it finishes')
        team = os.environ.get('DEVELOPMENT_TEAM', '')
        signing = ['-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'DEVELOPMENT_TEAM=' + team] if team else ['CODE_SIGNING_ALLOWED=NO']
        subprocess.run(['xcodebuild', '-project', str(ROOT / 'AsuraReader.xcodeproj'), '-target', 'Reader',
                        '-xcconfig', str(config), '-sdk', 'iphoneos', '-configuration', 'Release',
                        'SYMROOT=' + str(output), *signing, 'build'], check=True, cwd=ROOT)
    app = output / 'Release-iphoneos' / (provider['productName'] + '.app')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    for key, value in [('CFBundleIdentifier', bundle_id), ('CFBundleName', provider['productName']),
                       ('CFBundleDisplayName', provider['displayName']), ('ReaderProvider', provider['key'])]:
        if info.get(key) != value: raise SystemExit('Built app identity mismatch: ' + key)
    if any(key.startswith('CFBundleIcon') for key in info):
        raise SystemExit('Provider apps must not declare custom icons')
    if team:
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]))
        if profile.get('TeamIdentifier') != [team]: raise SystemExit('Wrong provisioning team')
        device = os.environ.get('DEVELOPMENT_DEVICE', '')
        if device and device not in profile.get('ProvisionedDevices', []):
            raise SystemExit('This iPhone is not in the provisioning profile; register it using a physical Xcode scheme build first')
    print('Verified provider app: ' + str(app))

if __name__ == '__main__': main()
