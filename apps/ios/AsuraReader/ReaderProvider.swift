import Foundation

// One provider per app; UI, storage, transfers, restore, and cache scheduling are shared.
protocol ReaderSource: Sendable {
    func catalog() async throws -> [Series]
    func chapters(_ slug: String) async throws -> [Chapter]
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String
    func prioritize(_ url: String) async
}
enum ProviderConfiguration: String, Sendable {
    case asura = "asurascans", scythe = "scythescans"
    static let current = ProviderConfiguration(rawValue: Bundle.main.object(forInfoDictionaryKey: "ReaderProvider") as? String ?? "asurascans") ?? .asura
    var appName: String { self == .asura ? "AsuraReader" : "ScytheReader" }
    var metadataKey: String { self == .asura ? "asura-ios-v1" : "scythe-ios-v1" }
    var origin: String { self == .asura ? "https://asurascans.com/" : "https://scythescans.com/" }
    func identity(_ slug: String) -> String {
        self == .asura ? slug.replacingOccurrences(of: "-[0-9a-f]{8}$", with: "", options: [.regularExpression, .caseInsensitive]) : slug
    }
    func makeSource() -> any ReaderSource { self == .asura ? AsuraAPI() : ScytheAPI() }
}
