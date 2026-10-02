#!/usr/bin/env python3
"""Print this repo's paid apps for ios-app-renewal's configure-refresh.py (runs on the Mac mirror)."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--team', required=True)
parser.add_argument('--device', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
apps = []
# One entry per provider in the generated registry; paid builds append '.paid' to each identity.
for key, provider in json.loads((root / 'build/providers.json').read_text()).items():
    apps.append(dict(name=key, root=str(root),
                     app='build/' + key + '.paid/Release-iphoneos/' + provider['productName'] + '.app',
                     bundleIds=[provider['bundleIdentifier'] + '.paid'],
                     # Fingerprint the provider's own Web bundle, never the shared Resources staging folder.
                     inputs=['AsuraReader', 'AsuraReader.xcodeproj', 'Resources/Info.plist', 'Resources/Native',
                             'build/' + key + '/Web', 'build/providers.json', 'Package.swift', 'scripts/build-guest.py'],
                     build=['/usr/bin/python3', 'scripts/build-guest.py', key],
                     environment={'DEVELOPMENT_TEAM': args.team, 'DEVELOPMENT_DEVICE': args.device,
                                  'READER_BUNDLE_SUFFIX': '.paid'}))
print(json.dumps(apps))
