import Foundation

// One provider per app; UI, storage, transfers, restore, and cache scheduling are shared.
protocol ReaderSource: Sendable {
    func catalog() async throws -> [Series]
    func chapters(_ slug: String) async throws -> [Chapter]
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String
    func prioritize(_ url: String) async
}
protocol AsuraSource: ReaderSource {
    func request(_ path: String, method: String, body: Data?, token: String?) async throws -> Data
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String
    func prioritize(_ url: String) async
}

enum ProviderConfiguration: String, Sendable {
    case asura = "asurascans", scythe = "scythescans"
    // Selected by the builder, never inferred from LiveContainer's host bundle.
    #if READER_ASURA || READER_TESTS
    static let current = ProviderConfiguration.asura
    #elseif READER_SCYTHE
    static let current = ProviderConfiguration.scythe
    #else
    #error("Select a provider with npm run build:ios -- <provider>")
    #endif
    var appName: String { self == .asura ? "AsuraReader" : "ScytheReader" }
    var metadataKey: String { self == .asura ? "asura-ios-v1" : "scythe-ios-v1" }
    var origin: String { self == .asura ? "https://asurascans.com/" : "https://scythescans.com/" }
    func identity(_ slug: String) -> String {
        self == .asura ? slug.replacingOccurrences(of: "-[0-9a-f]{8}$", with: "", options: [.regularExpression, .caseInsensitive]) : slug
    }
    func makeSource() -> any ReaderSource {
        #if READER_TESTS
        return self == .asura ? AsuraAPI() : ScytheAPI()
        #elseif READER_ASURA
        precondition(self == .asura)
        return AsuraAPI()
        #elseif READER_SCYTHE
        precondition(self == .scythe)
        return ScytheAPI()
        #endif
    }
}
