import Foundation
import SwiftSoup

// Mirrors src/provider/lua.ts and lua-catalog.ts; web HTML is data only.
actor LuaAPI: ReaderSource {
    private let api = ReaderHTTP(origin: ProviderConfiguration.lua.origin, apiBase: "https://api.luacomic.org")
    private let site = ReaderHTTP(origin: ProviderConfiguration.lua.origin, apiBase: "https://luacomic.org")
    func prioritize(_ url: String) async { await api.prioritize(url) }
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String { try await api.image(raw, to: destination, urgent: urgent) }
    static func chapter(_ row: [String: Any], locked: Bool = false) throws -> Chapter {
        guard let id = row["chapter_slug"] as? String, CachePolicy.validChapter(id) else { throw ReaderError.message("Invalid Lua chapter") }
        let index = CachePolicy.number(row["index"]).replacingOccurrences(of: "\\.0+$", with: "", options: .regularExpression)
        return Chapter(number: index.isEmpty ? NativeProviderData.chapterNumber(id) : index, id: id, locked: locked, published: row["created_at"] as? String ?? "")
    }
    func catalog() async throws -> [Series] {
        let data = try object(await api.request("/query?page=1&perPage=1000&series_type=Comic&query_string=&orderBy=latest&adult=true&status=All&tags_ids=%5B%5D"))
        guard let rows = data["data"] as? [[String: Any]] else { throw ReaderError.message("Invalid Lua catalog") }
        return try rows.map { row in
            guard let slug = row["series_slug"] as? String, CachePolicy.validSlug(slug), let title = row["title"] as? String,
                  let cover = row["thumbnail"] as? String else { throw ReaderError.message("Incomplete Lua series") }
            let paid = try (row["paid_chapters"] as? [[String: Any]] ?? []).map { try Self.chapter($0, locked: true) }
            let free = try (row["free_chapters"] as? [[String: Any]] ?? []).map { try Self.chapter($0) }
            return Series(slug: slug, identity: slug, title: title, cover: cover, chapters: Array(CachePolicy.ordered(paid + free).suffix(5)))
        }
    }
    func chapters(_ slug: String) async throws -> [Chapter] {
        let series = try object(await api.request("/series/\(slug)"))
        let id = CachePolicy.number(series["id"])
        guard !id.isEmpty else { throw ReaderError.message("Missing Lua series ID") }
        var result: [Chapter] = [], page = 1
        while true {
            try Task.checkCancellation()
            let data = try object(await api.request("/chapter/query?page=\(page)&perPage=100&order=desc&series_id=\(id)"))
            guard let rows = data["data"] as? [[String: Any]], let meta = data["meta"] as? [String: Any], let last = meta["last_page"] as? Int else { throw ReaderError.message("Invalid Lua chapter list") }
            result += try rows.map { try Self.chapter($0) }
            if page >= last { break }
            guard !rows.isEmpty, page < 10000 else { throw ReaderError.message("Invalid Lua pagination") }
            page += 1
        }
        return CachePolicy.ordered(result)
    }
    static func reader(_ html: String) throws -> (title: String, pages: [PageImage]) {
        let doc = try SwiftSoup.parse(html)
        let title = try doc.title().replacingOccurrences(of: "(?i)\\s+-\\s+Chapter\\s+[0-9.]+\\s+-\\s+Lua Comic$", with: "", options: .regularExpression)
        let pages = try doc.select("img[src]").compactMap { image -> PageImage? in
            let raw = try image.attr("src").components(separatedBy: .whitespacesAndNewlines).joined()
            guard let url = URL(string: raw), url.host == "media.luacomic.org", url.path.hasPrefix("/file/"), url.path.contains("/uploads/series/"), ["webp", "jpg", "png"].contains(url.pathExtension.lowercased()) else { return nil }
            return try NativeProviderData.image(raw)
        }
        guard !pages.isEmpty, !title.isEmpty, title != (try doc.title()) else { throw ReaderError.message("Lua chapter contains no reader data") }
        return (title, pages)
    }
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest {
        let html = String(decoding: try await site.request("/series/\(slug)/\(chapter)"), as: UTF8.self)
        let parsed = try Self.reader(html)
        return Manifest(slug: slug, chapter: chapter, title: parsed.title, seriesID: "", chapterID: chapter, pages: parsed.pages, chapters: try await chapters(slug))
    }
}
