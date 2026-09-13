import Foundation
import CryptoKit

struct Chapter: Codable, Sendable, Equatable {
    var number: String
    var id: String? = nil
    var key: String { id ?? number }
    var locked: Bool = false
    var published: String = ""
    var unlockAt: String? = nil
    var label: String? = nil
}
struct Series: Codable, Sendable {
    var slug: String
    var identity: String
    var title: String
    var cover: String
    var chapters: [Chapter]
}
struct PageImage: Codable, Sendable {
    var url: String
    var width: Double
    var height: Double
}
struct Manifest: Codable, Sendable {
    var slug: String
    var chapter: String
    var title: String
    var seriesID: String
    var chapterID: String
    var pages: [PageImage]
    var chapters: [Chapter]
    var key: String { CachePolicy.key(slug, chapter) }
}
struct Position: Codable, Sendable {
    var slug: String
    var chapter: String
    var page: Int
    var fraction: Double
    var total: Int
    var updatedAt: Double
    var complete: Bool { page >= total - 1 }
}
struct ViewPosition: Codable, Sendable {
    var path: String = "/"
    var anchor: String? = nil
    var fraction: Double = 0
    var y: Double = 0
}
struct AppState: Codable, Sendable {
    var version = 1
    var catalog: [Series] = []
    var progress: [String: Position] = [:]
    var history: [String: [String: Int]] = [:]
    var view = ViewPosition()
    var home = ViewPosition()
    var tokens: [String: String] = [:]
}
enum ReaderError: LocalizedError {
    case message(String)
    case http(Int)
    var errorDescription: String? { switch self { case let .message(text): return text; case let .http(status): return "Server returned HTTP \(status)" } }
}
enum CachePolicy {
    static func identity(_ slug: String) -> String {
        ProviderConfiguration.current.identity(slug)
    }
    static func key(_ slug: String, _ chapter: String) -> String {
        SHA256.hash(data: Data((identity(slug) + "/" + chapter).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func number(_ value: Any?) -> String {
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n.stringValue }
        return ""
    }
    // Native slots traverse oldest → newest; adapters receive newest-first lists.
    // Reverse the provider order exactly. Chapter numbers do not define adjacency.
    static func oldestFirst(_ newestFirst: [Chapter]) -> [Chapter] { Array(newestFirst.reversed()) }
    static func window(current: String, chapters: [Chapter]) -> [String] {
        let ordered = chapters
        guard let i = ordered.firstIndex(where: { $0.key == current }) else { return [current] }
        return [current] + (i + 1 < ordered.count ? [ordered[i + 1].key] : [])
    }
    // Provider IDs are opaque path segments, not Asura-only numeric routes.
    static func validSlug(_ slug: String) -> Bool { validSegment(slug, limit: 250) }
    static func validChapter(_ chapter: String) -> Bool { validSegment(chapter, limit: 300) }
    private static func validSegment(_ value: String, limit: Int) -> Bool {
        !value.isEmpty && value.count <= limit && value != "." && value != ".." &&
        value.rangeOfCharacter(from: .controlCharacters.union(CharacterSet(charactersIn: "/\\?#%"))) == nil
    }
}
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func jsonText(_ value: Any) throws -> String { String(decoding: try jsonData(value), as: UTF8.self) }
func object(_ data: Data) throws -> [String: Any] {
    guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ReaderError.message("Invalid server response") }
    return result
}
func chaptersFrom(_ rows: Any?) -> [Chapter] {
    CachePolicy.oldestFirst((rows as? [[String: Any]] ?? []).map { row in
        let until = (row["early_access_until"] as? String).flatMap { parseDate($0) }
        let premium = row["is_premium"] as? Bool ?? false
        return Chapter(number: CachePolicy.number(row["number"]), locked: premium && (until == nil || until! > Date()), published: row["published_at"] as? String ?? "", unlockAt: row["early_access_until"] as? String)
    })
}
func writeAtomically(_ data: Data, _ url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: [.atomic])
    #if os(iOS)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
    #endif
}

func parseDate(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}


struct CatalogPage: Sendable {
    var series: [Series]
    var total: Int?
    var hasMore: Bool
}
typealias CatalogUpdate = @Sendable (CatalogPage) async throws -> Void

// Same append/merge policy as src/routes/home.ts. Cards keep the first title,
// cover and chapter entries; subsequent pages fill the remaining five slots.
struct CatalogFeed {
    private(set) var series: [Series] = []
    private var indices: [String: Int] = [:]
    private var total: Int?
    private var firstPage = true
    mutating func append(_ rows: [Series], total: Int? = nil, hasMore: Bool, onPage: CatalogUpdate?) async throws {
        try Task.checkCancellation()
        if let total { self.total = total }
        for incoming in rows {
            if let index = indices[incoming.slug] {
                guard !firstPage else { throw ReaderError.message("First home page repeats series \(incoming.slug)") }
                var chapters = Array(series[index].chapters.reversed())
                var ids = Set(chapters.map(\.key))
                for chapter in incoming.chapters.reversed() where ids.insert(chapter.key).inserted { chapters.append(chapter) }
                series[index].chapters = CachePolicy.oldestFirst(Array(chapters.prefix(5)))
            } else {
                indices[incoming.slug] = series.count
                series.append(incoming)
            }
        }
        firstPage = false
        try await onPage?(CatalogPage(series: series, total: self.total, hasMore: hasMore))
        // Publish before waiting: the first batch is usable while pagination runs.
        if hasMore { try await Task.sleep(for: .seconds(1)) }
    }
}
