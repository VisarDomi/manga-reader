// swift-tools-version: 6.2
import PackageDescription

// The app's logic as separate modules, so a release build optimizes them in parallel and an edit
// recompiles only its own module (and those importing it), not the whole app. MangaReader/ holds
// only the UIKit screens. Keep new logic here: see apps/ios/README.md ("Modules").
let package = Package(
    name: "MangaCore",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [
        .library(name: "MangaSources", targets: ["MangaSources"]),
        .library(name: "MangaLibrary", targets: ["MangaLibrary"]),
    ],
    dependencies: [.package(path: "../Kit")],
    targets: [
        // The sites: request admission and pacing, background transfers, the seven providers.
        .target(name: "MangaSources", dependencies: [
            .product(name: "KitCore", package: "Kit"),
            .product(name: "KitNet", package: "Kit"),
            .product(name: "KitHTML", package: "Kit"),
            .product(name: "KitLifecycle", package: "Kit"),
        ]),
        // Reading state, saved chapters, downloads and the catalog walk.
        .target(name: "MangaLibrary", dependencies: [
            "MangaSources",
            .product(name: "KitCore", package: "Kit"),
            .product(name: "KitNet", package: "Kit"),
            .product(name: "KitLifecycle", package: "Kit"),
        ]),
    ]
)
