#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
signing=(CODE_SIGNING_ALLOWED=NO)
if [[ -n "${DEVELOPMENT_TEAM:-}" ]]; then
  signing=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM")
fi
xcodebuild -project AsuraReader.xcodeproj -target "${READER_TARGET:-AsuraReader}" -sdk iphoneos \
  -configuration Release "SYMROOT=${IOS_BUILD_DIR:-$PWD/build}" "${signing[@]}" build
