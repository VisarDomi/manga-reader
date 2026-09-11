#!/usr/bin/env python3
"""Sign pinned upstream LC with an Xcode-issued host profile. Mac GUI session."""
import hashlib
import pathlib
import plistlib
import shutil
import subprocess
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'LiveContainer-3.8.0.ipa'
SHA256 = 'b6fea95e30083382e29ffef88fa1aaa40b5069e1112e5307d490dab04648bba6'
IDENTITY = 'D50DEF2A492BF7B850F8F9A530AB75A23D6D0763'
BUNDLE = 'com.kdt.livecontainer.AVQL5DLWLT'
TEAM = 'AVQL5DLWLT'
assert hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == SHA256, 'Upstream IPA hash changed'
stub = ROOT / 'build/Release-iphoneos/LiveContainer.app'
profile = stub / 'embedded.mobileprovision'
grants = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(profile)], stderr=subprocess.DEVNULL))
assert grants['Entitlements']['application-identifier'] == TEAM + '.' + BUNDLE
assert IDENTITY in [hashlib.sha1(cert).hexdigest().upper() for cert in grants['DeveloperCertificates']]
entitlements = plistlib.loads((ROOT / 'Provisioning/Host.entitlements').read_bytes())
assert entitlements['get-task-allow'] is True
assert len(entitlements['keychain-access-groups']) == 128
assert entitlements.get('com.apple.security.application-groups'), 'Fast launcher requires an App Group'
assert set(entitlements['com.apple.security.application-groups']).issubset(
    grants['Entitlements'].get('com.apple.security.application-groups', [])), 'Profile has not granted the requested App Group'
stage = ROOT / 'build/signed'
if stage.exists():
    shutil.rmtree(stage)
stage.mkdir()
with zipfile.ZipFile(ARCHIVE) as archive:
    for item in archive.infolist():
        target = stage / item.filename
        assert target.resolve().is_relative_to(stage.resolve()), 'Unsafe archive path'
    archive.extractall(stage)
app = stage / 'Payload/LiveContainer.app'
# Upstream 3.8.0 Launch App uses ShareExtension as its helper. No LiveProcess needed.
extensions = ['LaunchAppExtension', 'ShareExtension']
shutil.rmtree(app / 'PlugIns/LiveProcess.appex', ignore_errors=True)
for name in extensions:
    extension = app / ('PlugIns/' + name + '.appex')
    extension_info = extension / 'Info.plist'
    data = plistlib.loads(extension_info.read_bytes())
    data['CFBundleIdentifier'] = BUNDLE + '.' + name
    extension_info.write_bytes(plistlib.dumps(data))
    # Match upstream supported installers' single-profile signing mode.
    shutil.copy2(profile, extension / 'embedded.mobileprovision')
info_file = app / 'Info.plist'
info = plistlib.loads(info_file.read_bytes())
info['CFBundleIdentifier'] = BUNDLE
info_file.write_bytes(plistlib.dumps(info))
shutil.copy2(profile, app / 'embedded.mobileprovision')
machos = []
for path in app.rglob('*'):
    if path.is_file():
        with path.open('rb') as stream:
            magic = stream.read(4)
        if magic in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'):
            path.chmod(0o755)
            machos.append(path)
for path in sorted(machos, key=lambda item: len(item.parts), reverse=True):
    if path != app / info['CFBundleExecutable']:
        subprocess.run(['codesign', '--force', '--sign', IDENTITY, '--timestamp=none', str(path)], check=True)
for framework in sorted(app.rglob('*.framework'), key=lambda item: len(item.parts), reverse=True):
    subprocess.run(['codesign', '--force', '--sign', IDENTITY, '--timestamp=none', str(framework)], check=True)
for name in extensions:
    subprocess.run(['codesign', '--force', '--sign', IDENTITY, '--timestamp=none', '--generate-entitlement-der', '--entitlements', str(ROOT / 'Provisioning/Host.entitlements'), str(app / ('PlugIns/' + name + '.appex'))], check=True)
subprocess.run(['codesign', '--force', '--sign', IDENTITY, '--timestamp=none', '--generate-entitlement-der', '--entitlements', str(ROOT / 'Provisioning/Host.entitlements'), str(app)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
print('Signed upstream LiveContainer:', app)
print('Profile expires:', grants['ExpirationDate'].isoformat())
