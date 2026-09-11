import Foundation
import CryptoKit

struct Chapter: Codable, Sendable, Equatable {
    var number: String
    var id: String? = nil
    var key: String { id ?? number }
    var locked: Bool = false
    var published: String = ""
    var unlockAt: String? = nil
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
    static func ordered(_ chapters: [Chapter]) -> [Chapter] {
        var seen = Set<String>()
        return chapters.filter { !$0.number.isEmpty && seen.insert($0.key).inserted }
            .sorted { (Double($0.number) ?? 0) < (Double($1.number) ?? 0) }
    }
    static func window(current: String, chapters: [Chapter]) -> [String] {
        let ordered = ordered(chapters)
        guard let i = ordered.firstIndex(where: { $0.key == current }) else { return [current] }
        return [current] + (i + 1 < ordered.count ? [ordered[i + 1].key] : [])
    }
    static func validSlug(_ slug: String) -> Bool {
        !slug.isEmpty && slug.count <= 250 && slug.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil
    }
    static func validChapter(_ chapter: String) -> Bool {
        chapter.count <= 300 && chapter.range(of: "^(?:[0-9]+(?:[.][0-9]+)?|[a-zA-Z0-9_-]+-chapter-[0-9]+(?:[.][0-9]+)?(?:-[0-9]+)?)$", options: .regularExpression) != nil
    }
}
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func jsonText(_ value: Any) throws -> String { String(decoding: try jsonData(value), as: UTF8.self) }
func object(_ data: Data) throws -> [String: Any] {
    guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ReaderError.message("Invalid server response") }
    return result
}
func chaptersFrom(_ rows: Any?) -> [Chapter] {
    CachePolicy.ordered((rows as? [[String: Any]] ?? []).map { row in
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
