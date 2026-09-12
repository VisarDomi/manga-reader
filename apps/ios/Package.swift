// swift-tools-version: 6.0
import PackageDescription

// Native tests use the same sources and parser version as both iOS targets.
let package = Package(name: "ReaderCoreTests", platforms: [.macOS(.v13)], dependencies: [
    .package(url: "https://github.com/scinfu/SwiftSoup.git", revision: "0a1cd58aec8774d4110b2ceb8971061eac964efd")
], targets: [
    .executableTarget(name: "ReaderCoreTests", dependencies: ["SwiftSoup"], path: ".",
        exclude: ["Resources", "AsuraReader.xcodeproj", "build", "scripts", "DEVELOPMENT.md", "AsuraReader/AppDelegate.swift", "AsuraReader/WebController.swift", "Tests/browser.mjs"],
        sources: ["AsuraReader/ReaderHTTP.swift", "AsuraReader/Models.swift", "AsuraReader/ReaderProvider.swift", "AsuraReader/AsuraAPI.swift", "AsuraReader/ScytheAPI.swift", "AsuraReader/PCBackup.swift", "AsuraReader/ReaderStore.swift", "Tests/CoreTests.swift"], swiftSettings: [.define("READER_TESTS")])
])
