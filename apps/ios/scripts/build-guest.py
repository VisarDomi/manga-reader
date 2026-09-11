#!/usr/bin/env python3
"""Build a provider app on the Mac without provisioning an Apple app ID."""
import argparse, fcntl, os, pathlib, subprocess
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('provider', choices=['asura', 'scythe'])
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
cache = pathlib.Path.home() / 'Library/Caches/ios-app-refresh'
cache.mkdir(parents=True, exist_ok=True)
with (cache / 'signing.lock').open('a') as lock:
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: raise SystemExit('Another app is building/signing; retry after it finishes')
    if subprocess.run(['pgrep', '-x', 'xcodebuild'], stdout=subprocess.DEVNULL).returncode == 0:
        raise SystemExit('An Xcode build is running; retry after it finishes')
    env = dict(os.environ, DEVELOPMENT_TEAM='', READER_TARGET={'asura':'AsuraReader','scythe':'ScytheReader'}[args.provider])
    subprocess.run(['/bin/bash', str(root / 'scripts/build.sh')], env=env, check=True)
