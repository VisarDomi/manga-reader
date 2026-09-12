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
    case asura = "asurascans", scythe = "scythescans", ezmanga = "ezmanga", qiscans = "qimanga", yaksha = "yakshacomics", lua = "luacomic"
    // Selected by the builder, never inferred from LiveContainer's host bundle.
    #if READER_ASURA || READER_TESTS
    static let current = ProviderConfiguration.asura
    #elseif READER_SCYTHE
    static let current = ProviderConfiguration.scythe
    #elseif READER_EZMANGA
    static let current = ProviderConfiguration.ezmanga
    #elseif READER_QISCANS
    static let current = ProviderConfiguration.qiscans
    #elseif READER_YAKSHA
    static let current = ProviderConfiguration.yaksha
    #elseif READER_LUA
    static let current = ProviderConfiguration.lua
    #else
    #error("Select a provider with npm run build:ios -- <provider>")
    #endif
    var appName: String {
        switch self {
        case .asura: return "AsuraReader"
        case .scythe: return "ScytheReader"
        case .ezmanga: return "EzMangaReader"
        case .qiscans: return "QiMangaReader"
        case .yaksha: return "YakshaReader"
        case .lua: return "LuaReader"
        }
    }
    var metadataKey: String { appName.replacingOccurrences(of: "Reader", with: "").lowercased() + "-ios-v1" }
    var origin: String {
        switch self {
        case .asura: return "https://asurascans.com/"
        case .scythe: return "https://scythescans.com/"
        case .ezmanga: return "https://ezmanga.org/"
        case .qiscans: return "https://qimanga.com/"
        case .yaksha: return "https://yakshacomics.com/"
        case .lua: return "https://luacomic.org/"
        }
    }
    func identity(_ slug: String) -> String {
        self == .asura ? slug.replacingOccurrences(of: "-[0-9a-f]{8}$", with: "", options: [.regularExpression, .caseInsensitive]) : slug
    }
    func makeSource() -> any ReaderSource {
        #if READER_TESTS
        switch self {
        case .asura: return AsuraAPI()
        case .scythe: return ScytheAPI()
        case .ezmanga, .qiscans: return AngularAPI(provider: self)
        case .yaksha: return YakshaAPI()
        case .lua: return LuaAPI()
        }
        #elseif READER_ASURA
        precondition(self == .asura)
        return AsuraAPI()
        #elseif READER_SCYTHE
        precondition(self == .scythe)
        return ScytheAPI()
        #elseif READER_EZMANGA || READER_QISCANS
        return AngularAPI(provider: self)
        #elseif READER_YAKSHA
        return YakshaAPI()
        #elseif READER_LUA
        return LuaAPI()
        #endif
    }
}
