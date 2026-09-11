#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/tests
xcrun swiftc -parse-as-library -swift-version 6 \
  AsuraReader/Models.swift AsuraReader/AsuraAPI.swift AsuraReader/PCBackup.swift AsuraReader/ReaderStore.swift \
  Tests/CoreTests.swift -o build/tests/core
build/tests/core
