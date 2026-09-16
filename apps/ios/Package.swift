// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "ReaderCoreTests", platforms: [.macOS(.v13)], targets: [
    .executableTarget(name: "ReaderCoreTests", path: ".",
        exclude: ["Resources", "AsuraReader.xcodeproj", "build", "scripts", "web", "DEVELOPMENT.md", "PAID-NATIVE.md", "tsconfig.json", "AsuraReader/AppDelegate.swift", "AsuraReader/WebController.swift", "Tests/browser.mjs", "Tests/builder.test.mjs", "Tests/test_signing_lock.py"],
        sources: ["AsuraReader/ReaderHTTP.swift", "AsuraReader/ImageDownloader.swift", "AsuraReader/Models.swift", "AsuraReader/PCBackup.swift", "AsuraReader/ReaderStore.swift", "Tests/CoreTests.swift"])
])
