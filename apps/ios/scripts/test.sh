#!/bin/bash
# The native core's tests (on the PC; the Mac works too): all seven providers against saved responses
# (Tests/Fixtures), and the reading state's format, migrations and rules.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=../Kit/Linux/swift-env.sh
source Kit/Linux/swift-env.sh
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/manga-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
build_linux_shims "$test_dir"
# Compile a private snapshot: a concurrent source sync cannot change compiler
# inputs halfway through a check. Product delivery separately freezes its source.
mkdir -p "$test_dir/source/Kit"
cp -R MangaReader Tests "$test_dir/source/"
cp -R Kit/Sources "$test_dir/source/Kit/"
cd "$test_dir/source"
kit_libraries "$test_dir" "" KitCore KitNet KitHTML KitLifecycle
"${SWIFTC[@]}" ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -swift-version 6 -j "$JOBS" -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitHTML "${XML_FLAGS[@]}" -lKitLifecycle -Xlinker -rpath -Xlinker "$test_dir" \
  MangaReader/Providers.swift MangaReader/Site.swift MangaReader/SiteTransfers.swift MangaReader/Store.swift MangaReader/PageRetention.swift MangaReader/RetrySchedule.swift MangaReader/Downloads.swift MangaReader/Library.swift MangaReader/NotificationObservation.swift Tests/WorkloadScenario.swift Tests/RequestLimitChecks.swift Tests/MangaTests.swift -o "$test_dir/manga-tests"
"$test_dir/manga-tests" Tests/Fixtures
