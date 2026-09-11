#!/usr/bin/env python3
"""Run on the signing Mac. Reuse its GUI Keychain and existing daily renewal flow."""
import argparse
import base64
import fcntl
import json
import pathlib
import plistlib
import subprocess
import urllib.parse
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEVICE = '00008101-000639912881401E'
BUNDLE = 'com.kdt.livecontainer.AVQL5DLWLT'
IDENTITY = 'D50DEF2A492BF7B850F8F9A530AB75A23D6D0763'
APP = ROOT / 'build/signed/Payload/LiveContainer.app'
CONFIG = ROOT / 'refresh.local.json'
PRIVATE = ROOT / 'private'
GUI = 'gui/501'

def command(argv):
    subprocess.run([str(value) for value in argv], check=True)

def job(name, argv):
    label = 'com.visar.livecontainer-' + name
    # Do not replace or interrupt an already running job.
    info = subprocess.run(['launchctl', 'list', label], capture_output=True, text=True)
    if info.returncode == 0:
        if '"PID"' in info.stdout:
            raise SystemExit(label + ' is already running')
        command(['launchctl', 'bootout', GUI + '/' + label])
    jobs = ROOT / 'build/jobs'
    jobs.mkdir(parents=True, exist_ok=True)
    path = jobs / (name + '.plist')
    path.write_bytes(plistlib.dumps({
        'Label': label, 'ProgramArguments': [str(value) for value in argv],
        'WorkingDirectory': str(ROOT), 'RunAtLoad': True,
        'StandardOutPath': str(ROOT / ('build/' + name + '.log')),
        'StandardErrorPath': str(ROOT / ('build/' + name + '.log')),
    }))
    command(['launchctl', 'bootstrap', GUI, path])
    print('Started', label, '; check build/' + name + '.log and launchctl status.')

def launch(url=None, private=False):
    argv = ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', DEVICE]
    if url:
        argv += ['--payload-url', url]
    argv += [BUNDLE]
    if private:
        # devicectl diagnostics can include command arguments containing the P12.
        result = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise SystemExit('Certificate handoff failed; sensitive diagnostics suppressed')
        print('Dispatched LC certificate callback; verify its JIT-less test on the phone.')
    else:
        command(argv)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['prepare', 'build', 'build-worker', 'install', 'export-identity',
    'import-certificate', 'import-app', 'launch-asura', 'launch-scythe', 'open-ui', 'approve', 'renew-wireless',
    'enable-renewal', 'status'])
parser.add_argument('app_path', nargs='?')
args = parser.parse_args()
(ROOT / 'build').mkdir(exist_ok=True)
PRIVATE.mkdir(exist_ok=True, mode=0o700)

if args.action == 'prepare':
    archive = ROOT / 'LiveContainer-3.8.0.ipa'
    if not archive.exists():
        urllib.request.urlretrieve('https://github.com/LiveContainer/LiveContainer/releases/download/3.8.0/LiveContainer.ipa', archive)
    if not CONFIG.exists():
        config = json.loads((ROOT / 'refresh.example.json').read_text())
        config['root'] = str(ROOT)
        CONFIG.write_text(json.dumps(config, indent=2) + '\n')
    print('Prepared pinned IPA and local config. Build validates the archive hash.')
elif args.action == 'build':
    job('build', ['/usr/bin/caffeinate', '-i', '/usr/bin/python3', ROOT / 'scripts/deploy.py', 'build-worker'])
elif args.action == 'build-worker':
    lock_dir = pathlib.Path.home() / 'Library/Caches/ios-app-refresh'
    lock_dir.mkdir(parents=True, exist_ok=True)
    with (lock_dir / 'signing.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Another app is signing; retry after it finishes')
        if subprocess.run(['pgrep', '-x', 'xcodebuild'], stdout=subprocess.DEVNULL).returncode == 0:
            raise SystemExit('An Xcode build is already running; retry after it finishes')
        command(['/bin/bash', ROOT / 'scripts/build.sh'])
elif args.action == 'install':
    command(['codesign', '--verify', '--deep', '--strict', APP])
    command(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', DEVICE, APP])
elif args.action == 'export-identity':
    if (PRIVATE / 'identity.p12').exists() and (PRIVATE / 'identity.password').exists():
        print('Reusing the existing private identity export.')
    else:
        executable = ROOT / 'build/export-identity'
        command(['xcrun', 'swiftc', ROOT / 'scripts/export-identity.swift', '-o', executable])
        job('export', [executable, IDENTITY, PRIVATE])
elif args.action == 'import-certificate':
    payload = urllib.parse.urlencode({'cert': base64.b64encode((PRIVATE / 'identity.p12').read_bytes()).decode(),
                                     'password': (PRIVATE / 'identity.password').read_text()})
    launch('livecontainer://certificate?' + payload, private=True)
elif args.action == 'import-app':
    if not args.app_path:
        raise SystemExit('Pass the path to the built guest .app directory')
    source = pathlib.Path(args.app_path).resolve()
    if not source.is_dir() or source.suffix != '.app':
        raise SystemExit('Expected a built .app directory')
    archive = PRIVATE / (source.stem + '.ipa')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
        for path in source.rglob('*'):
            if path.is_file():
                output.write(path, 'Payload/' + source.name + '/' + str(path.relative_to(source)))
    result_path = PRIVATE / 'copy-result.json'
    command(['xcrun', 'devicectl', '--json-output', result_path, 'device', 'copy', 'to',
             '--device', DEVICE, '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
             '--source', archive, '--destination', 'Documents/' + archive.name])
    destination = json.loads(result_path.read_text())['result']['destination']
    launch('livecontainer://install?' + urllib.parse.urlencode({'url': destination}))
elif args.action in ['launch-asura', 'launch-scythe']:
    guest = 'AsuraReader' if args.action == 'launch-asura' else 'ScytheReader'
    launch('livecontainer://livecontainer-launch?bundle-name=com.visar.' + guest + '.app')
elif args.action == 'open-ui':
    command(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', DEVICE, '--terminate-existing',
             '--payload-url', 'livecontainer://livecontainer-launch?bundle-name=ui', BUNDLE])
elif args.action == 'approve':
    command(['/usr/bin/python3', ROOT / 'scripts/refresh.py', 'approve', '--config', CONFIG])
elif args.action == 'renew-wireless':
    job('renew', ['/usr/bin/caffeinate', '-i', '/usr/bin/python3', ROOT / 'scripts/refresh.py',
                  'refresh', '--force', '--wireless', '--config', CONFIG])
elif args.action == 'enable-renewal':
    command(['/usr/bin/python3', ROOT / 'scripts/install-refresh.py', '--config', CONFIG,
             '--template', ROOT / 'launchd/com.visar.livecontainer-refresh.plist.in'])
elif args.action == 'status':
    command(['/usr/bin/python3', ROOT / 'scripts/refresh.py', 'status', '--config', CONFIG])
    command(['launchctl', 'list', 'com.visar.livecontainer-refresh'])
