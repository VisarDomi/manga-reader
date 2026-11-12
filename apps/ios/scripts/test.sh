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
cp -R Core Tests "$test_dir/source/"
cp -R Kit/Sources "$test_dir/source/Kit/"
cd "$test_dir/source"
kit_libraries "$test_dir" "" KitCore KitNet KitHTML KitLifecycle
linking=(-swift-version 6 -j "$JOBS" -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitHTML "${XML_FLAGS[@]}" -lKitLifecycle -Xlinker -rpath -Xlinker "$test_dir")
# The app's logic modules (Core/Package.swift), separate as in the app, testable from Tests/.
for module in MangaSources MangaLibrary; do
  "${SWIFTC[@]}" ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} "${linking[@]}" -enable-testing -emit-library -emit-module -module-name "$module" \
    Core/Sources/"$module"/*.swift -emit-module-path "$test_dir/$module.swiftmodule" -o "$test_dir/lib$module.$DYLIB" $(library_flags "$module")
  linking+=("-l$module")
done
"${SWIFTC[@]}" ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} "${linking[@]}" \
  Tests/WorkloadScenario.swift Tests/RequestLimitChecks.swift Tests/PCRouteChecks.swift Tests/MangaTests.swift -o "$test_dir/manga-tests"
"$test_dir/manga-tests" Tests/Fixtures
