#!/bin/bash
# The native core's tests on the Mac: the six providers against saved responses
# (Tests/Fixtures), and the reading state's format, migrations and rules.
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/manga-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
for module in KitCore KitNet KitHTML; do
  deps=()
  [[ $module == KitNet ]] && deps=(-I "$test_dir" -L "$test_dir" -lKitCore)
  [[ $module == KitHTML ]] && deps=(-lxml2)
  xcrun swiftc -parse-as-library -emit-library -emit-module -module-name $module Kit/Sources/$module/*.swift ${deps[@]+"${deps[@]}"} \
    -emit-module-path "$test_dir/$module.swiftmodule" -o "$test_dir/lib$module.dylib" -Xlinker -install_name -Xlinker @rpath/lib$module.dylib
done
xcrun swiftc -parse-as-library -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitHTML -Xlinker -rpath -Xlinker "$test_dir" \
  MangaReader/Providers.swift MangaReader/Site.swift MangaReader/Store.swift Tests/MangaTests.swift -o "$test_dir/manga-tests"
"$test_dir/manga-tests" Tests/Fixtures
