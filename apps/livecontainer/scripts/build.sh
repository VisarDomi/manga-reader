#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
xcodebuild -project Provisioning.xcodeproj -target LiveContainer -sdk iphoneos \
  -configuration Release "SYMROOT=$PWD/build" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM=AVQL5DLWLT build
/usr/bin/python3 scripts/package.py
