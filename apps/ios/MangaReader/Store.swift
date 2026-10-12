import CoreGraphics
import CryptoKit
import Foundation
import KitCore

// MARK: - Reading progress (database.json, the web version's format; the PC keeps the same)

// Any JSON value, kept as it was (the database's legacy rows).
enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

// Where a series was left: one per series (`seriesSlug` is the series identity).
struct Progress: Codable, Sendable, Equatable {
    var id: String
    var provider: String
    var seriesSlug: String
    var chapterId: String
    var imageIndex: Int
    var totalImages: Int
    // Milliseconds since 1970.
    var updatedAt: Double

    static func id(_ provider: String, _ series: String) -> String { provider + "\u{0}" + series }

    var complete: Bool { imageIndex >= totalImages - 1 }

    init(provider: String, series: String, chapterId: String, imageIndex: Int, totalImages: Int, updatedAt: Double) throws {
        guard imageIndex >= 0 else { throw StoreError.invalid("Cannot save an invalid page index") }
        guard totalImages > 0, imageIndex < totalImages else { throw StoreError.invalid("Cannot save progress outside the chapter page range") }
        id = Self.id(provider, series)
        self.provider = provider
        seriesSlug = series
        self.chapterId = chapterId
        self.imageIndex = imageIndex
        self.totalImages = totalImages
        self.updatedAt = updatedAt
    }
}

enum StoreError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}

struct Database: Codable, Sendable, Equatable {
    struct Row: Codable, Sendable, Equatable { var key: String; var value: JSONValue }
    struct Stores: Codable, Sendable, Equatable {
        var progress: [Progress]
        var tokens: [Row]
        var metadata: [Row]
    }
    var version: Int
    var indexedDB: Stores

    static let schemaKey = "progress-schema-version"
    static var empty: Database { Database(version: 1, indexedDB: Stores(progress: [], tokens: [], metadata: [Row(key: schemaKey, value: .number(3))])) }

    // The PC's and the web version's rules (backup.ts): schema 3, valid unique positions.
    static func validate(_ data: Data) throws -> Database {
        let database: Database
        do { database = try JSONDecoder().decode(Database.self, from: data) }
        catch { throw StoreError.invalid("Invalid manga backup") }
        guard database.version == 1 else { throw StoreError.invalid("Invalid manga backup") }
        var ids = Set<String>()
        for entry in database.indexedDB.progress {
            let valid = try Progress(provider: entry.provider, series: entry.seriesSlug, chapterId: entry.chapterId,
                                     imageIndex: entry.imageIndex, totalImages: entry.totalImages, updatedAt: entry.updatedAt)
            guard entry.updatedAt.isFinite, valid.id == entry.id, ids.insert(entry.id).inserted else { throw StoreError.invalid("Invalid or duplicate progress identity") }
        }
        for rows in [database.indexedDB.tokens, database.indexedDB.metadata] {
            var keys = Set<String>()
            for row in rows where !keys.insert(row.key).inserted { throw StoreError.invalid("Invalid record") }
        }
        guard database.indexedDB.metadata.contains(where: { $0.key == schemaKey && $0.value == .number(3) }) else {
            throw StoreError.invalid("Unsupported progress backup schema")
        }
        return database
    }

    // A stored file of any schema, brought to schema 3 (migrations.ts); `changed` when it
    // needs writing back.
    static func load(_ data: Data) throws -> (database: Database, changed: Bool) {
        var database: Database
        do { database = try JSONDecoder().decode(Database.self, from: data) }
        catch { throw StoreError.invalid("Invalid reading state") }
        var entries = database.indexedDB.progress
        var version: Double
        var changed = false
        if case .number(let stored)? = database.indexedDB.metadata.first(where: { $0.key == schemaKey })?.value { version = stored }
        else {
            version = entries.isEmpty ? 3 : entries.contains { $0.id != Progress.id($0.provider, $0.seriesSlug) } ? 1 : 2
            changed = true
        }
        if version == 1 {
            // One position per series: the last visited page.
            entries = latest(entries) { $0.seriesSlug }
            version = 2
            changed = true
        }
        if version == 2 {
            // Old Asura URL slugs fold into the series identity.
            entries = latest(entries.map { entry in
                var entry = entry
                if entry.provider == "asurascans" { entry.seriesSlug = Asura.historyId(entry.seriesSlug) }
                return entry
            }) { $0.seriesSlug }
            version = 3
            changed = true
        }
        guard version == 3 else { throw StoreError.invalid("Unsupported progress schema version: \(version)") }
        var ids = Set<String>()
        for entry in entries {
            guard entry.id == Progress.id(entry.provider, entry.seriesSlug), ids.insert(entry.id).inserted else {
                throw StoreError.invalid("Stored progress does not match the current schema")
            }
        }
        database.indexedDB.progress = entries
        database.indexedDB.metadata.removeAll { $0.key == schemaKey }
        database.indexedDB.metadata.append(Row(key: schemaKey, value: .number(3)))
        return (database, changed)
    }

    private static func latest(_ entries: [Progress], series: (Progress) -> String) -> [Progress] {
        var order: [String] = [], result: [String: Progress] = [:]
        for var entry in entries {
            entry.id = Progress.id(entry.provider, series(entry))
            if let current = result[entry.id] {
                if entry.updatedAt >= current.updatedAt { result[entry.id] = entry }
            } else {
                order.append(entry.id)
                result[entry.id] = entry
            }
        }
        return order.compactMap { result[$0] }
    }
}

extension Notification.Name {
    static let progressChanged = Notification.Name("MangaProgressChanged")
}

// The phone's reading state: where each series was left. Every change is written at once
// (off the main thread, atomically and synced), so a kill keeps the last page read.
@MainActor
final class ReadingState {
    let provider: String
    private(set) var database: Database
    private(set) var bySeries: [String: Progress] = [:]
    private let writer: BackgroundWriter

    init(directory: URL, provider: String) {
        self.provider = provider
        writer = BackgroundWriter(url: directory.appendingPathComponent("database.json"), label: "manga-database")
        var database = Database.empty
        if let data = try? Data(contentsOf: writer.url) {
            do {
                let loaded = try Database.load(data)
                database = loaded.database
                if loaded.changed { try? DurableFile.write(Self.encode(database), to: writer.url) }
            } catch {
                // Never overwrite what cannot be read: set it aside (a PC Load restores).
                let aside = writer.url.deletingLastPathComponent().appendingPathComponent("database.unreadable-\(Int(Date().timeIntervalSince1970)).json")
                try? FileManager.default.moveItem(at: writer.url, to: aside)
                Log.store.error("Reading state unreadable, kept as \(aside.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        self.database = database
        index()
    }

    nonisolated static func encode(_ database: Database) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(database)
    }

    private func index() {
        bySeries = Dictionary(database.indexedDB.progress.filter { $0.provider == provider }.map { ($0.seriesSlug, $0) }, uniquingKeysWith: { $1 })
    }

    func progress(_ series: String) -> Progress? { bySeries[series] }

    // Started series, the most recently read first.
    var started: [Progress] { bySeries.values.sorted { $0.updatedAt > $1.updatedAt } }

    // A settled page; nothing is written when it did not change.
    func save(series: String, chapterId: String, imageIndex: Int, totalImages: Int) {
        if let current = bySeries[series], current.chapterId == chapterId, current.imageIndex == imageIndex, current.totalImages == totalImages { return }
        guard let entry = try? Progress(provider: provider, series: series, chapterId: chapterId, imageIndex: imageIndex,
                                        totalImages: totalImages, updatedAt: (Date().timeIntervalSince1970 * 1000).rounded()) else { return }
        database.indexedDB.progress.removeAll { $0.id == entry.id }
        database.indexedDB.progress.append(entry)
        bySeries[series] = entry
        persist()
    }

    private func persist() {
        let database = database
        writer.save { try Self.encode(database) }
        NotificationCenter.default.post(name: .progressChanged, object: nil)
    }

    func flush() { writer.flush() }

    // The PC save: this site's positions with the rest of the database.
    func backup() throws -> Data {
        var database = database
        database.indexedDB.progress = database.indexedDB.progress.filter { $0.provider == provider }
        return try Self.encode(database)
    }

    // A PC save replaces this site's positions (other sites' and the tokens stay).
    func restore(_ data: Data) throws {
        var incoming = try Database.validate(data)
        guard incoming.indexedDB.progress.allSatisfy({ $0.provider == provider }) else { throw StoreError.invalid("Wrong provider in PC state") }
        incoming.indexedDB.progress += database.indexedDB.progress.filter { $0.provider != provider }
        incoming.indexedDB.tokens = database.indexedDB.tokens
        database = incoming
        index()
        persist()
    }
}

// MARK: - Saved chapters and chapter lists (chapters/<sha256(key)>.json, the web's keys)

enum FileKey {
    static func sha256(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }

    // JavaScript's JSON.stringify of an array of strings.
    static func stringify(_ values: [String]) -> String {
        "[" + values.map { value in
            var out = "\""
            for scalar in value.unicodeScalars {
                switch scalar {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                case "\u{8}": out += "\\b"
                case "\u{c}": out += "\\f"
                default:
                    if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
                }
            }
            return out + "\""
        }.joined(separator: ",") + "]"
    }

    static func chapter(_ series: String, _ chapterId: String) -> String { stringify([series, chapterId]) }
    static func list(_ series: String) -> String { stringify(["chapters", series]) }
}

// A chapter's pages and a series' chapter list, as last fetched: reopening never waits for
// the network, and prepared chapters read offline.
actor ChapterFiles {
    private let directory: URL
    private var memory: [String: ChapterData] = [:]

    init(directory: URL) { self.directory = directory.appendingPathComponent("chapters") }

    private nonisolated func file(_ key: String) -> URL { directory.appendingPathComponent(FileKey.sha256(key) + ".json") }

    // A saved chapter read on the calling thread (a relaunch lays it out before the first frame).
    nonisolated func chapterNow(_ series: String, _ chapterId: String) -> ChapterData? {
        guard let data = try? DurableFile.readJSON(ChapterData.self, from: file(FileKey.chapter(series, chapterId))), !data.images.isEmpty else { return nil }
        return data
    }

    func chapter(_ series: String, _ chapterId: String) -> ChapterData? {
        let key = FileKey.chapter(series, chapterId)
        if let kept = memory[key] { return kept }
        guard let data = try? DurableFile.readJSON(ChapterData.self, from: file(key)), !data.images.isEmpty else { return nil }
        remember(key, data)
        return data
    }

    func save(_ data: ChapterData, series: String) {
        let key = FileKey.chapter(series, data.chapterId)
        remember(key, data)
        do { try DurableFile.writeJSON(data, to: file(key)) }
        catch { Log.store.error("Chapter not saved: \(error.localizedDescription, privacy: .public)") }
    }

    // Page sizes learnt from the images themselves (sites that give none), so the next
    // opening lays the chapter out exactly.
    func recordSizes(_ sizes: [Int: CGSize], series: String, chapterId: String) {
        guard var data = chapter(series, chapterId) else { return }
        var changed = false
        for (index, size) in sizes where data.images.indices.contains(index) && data.images[index].width == nil && size.width > 0 && size.height > 0 {
            data.images[index].width = Double(size.width)
            data.images[index].height = Double(size.height)
            changed = true
        }
        if changed { save(data, series: series) }
    }

    func remove(_ series: String, _ chapterId: String) {
        let key = FileKey.chapter(series, chapterId)
        memory[key] = nil
        try? FileManager.default.removeItem(at: file(key))
    }

    private func remember(_ key: String, _ data: ChapterData) {
        if memory.count > 64 { memory.removeAll() }
        memory[key] = data
    }

    private struct Item: Codable { var chapterId: String }

    func list(_ series: String) -> [String]? {
        (try? DurableFile.readJSON([Item].self, from: file(FileKey.list(series))))?.map(\.chapterId)
    }

    func saveList(_ chapters: [String], series: String) {
        do { try DurableFile.writeJSON(chapters.map(Item.init), to: file(FileKey.list(series))) }
        catch { Log.store.error("Chapter list not saved: \(error.localizedDescription, privacy: .public)") }
    }

    // When the site last gave the list (written, or confirmed unchanged).
    func listChecked(_ series: String) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: file(FileKey.list(series)).path))?[.modificationDate] as? Date
    }

    func touchList(_ series: String) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file(FileKey.list(series)).path)
    }
}

// Chapters that `newer` (newest first: a Home row, an earlier list) has ahead of `list`, put
// in front only when the rest of `newer` continues `list` exactly for at least two chapters:
// true of a run of the newest chapters, never of a selection that skips some, so a chapter is
// never skipped. Otherwise `list` unchanged.
func withNewerChapters(_ list: [String], _ newer: [String]) -> [String] {
    guard let first = list.first, let head = newer.firstIndex(of: first), head > 0 else { return list }
    let overlap = min(newer.count - head, list.count)
    guard overlap >= 2 else { return list }
    for index in 0..<overlap where newer[head + index] != list[index] { return list }
    return Array(newer[..<head]) + list
}

// MARK: - The catalog as last seen (catalog.json): Home opens with it at once

struct Catalog: Codable, Sendable, Equatable {
    var series: [HomeSeries] = []
    var total: Int?
    // Every page was read at least once.
    var complete = false
    var fetchedAt: Date?

    // A fresh run of pages (newest first) in front, the rest as they were.
    static func merged(_ cached: [HomeSeries], fresh: [HomeSeries], identity: (HomeSeries) -> String) -> [HomeSeries] {
        var seen = Set<String>(), result: [HomeSeries] = []
        for series in fresh {
            let id = identity(series)
            if seen.insert(id).inserted { result.append(series) }
            else if let index = result.firstIndex(where: { identity($0) == id }) {
                // A series seen twice (latest updates, then the catalog): new chapters join.
                var known = result[index]
                let ids = Set(known.chapters.map(\.chapterId))
                known.chapters = Array((known.chapters + series.chapters.filter { !ids.contains($0.chapterId) }).prefix(5))
                result[index] = known
            }
        }
        for series in cached where seen.insert(identity(series)).inserted { result.append(series) }
        return result
    }
}
