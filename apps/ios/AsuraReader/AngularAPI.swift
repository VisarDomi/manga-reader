import Foundation

// Shared by EzManga/QiManga, like src/provider/angular.ts and angular-catalog.ts.
actor AngularAPI: ReaderSource {
    private let http: ReaderHTTP
    init(provider: ProviderConfiguration) {
        precondition(provider == .ezmanga || provider == .qiscans)
        http = ReaderHTTP(origin: provider.origin, apiBase: provider == .ezmanga ? "https://vapi.ezmanga.org/api/v1" : "https://api.qimanga.com/api/v1")
    }
    func prioritize(_ url: String) async { await http.prioritize(url) }
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String { try await http.image(raw, to: destination, urgent: urgent) }
    private func json(_ path: String) async throws -> [String: Any] { try object(await http.request(path)) }
    static func chapter(_ row: [String: Any]) throws -> Chapter {
        guard let id = row["slug"] as? String, CachePolicy.validChapter(id) else { throw ReaderError.message("Invalid chapter ID") }
        let number = CachePolicy.number(row["number"])
        let date = (row["becameFreeAt"] as? String).flatMap(parseDate)
        let locked = (row["price"] as? Double ?? 0) > 0 && (date == nil || date! > Date())
        return Chapter(number: number.isEmpty ? NativeProviderData.chapterNumber(id) : number, id: id, locked: locked,
                       published: (!locked ? row["becameFreeAt"] as? String : nil) ?? row["createdAt"] as? String ?? "", unlockAt: locked ? row["becameFreeAt"] as? String : nil)
    }
    static func series(_ row: [String: Any]) throws -> Series {
        guard let slug = row["slug"] as? String, CachePolicy.validSlug(slug), let title = row["title"] as? String else { throw ReaderError.message("Incomplete catalog series") }
        return Series(slug: slug, identity: slug, title: title.trimmingCharacters(in: .whitespacesAndNewlines), cover: row["cover"] as? String ?? "",
                      chapters: CachePolicy.ordered(try (row["chapters"] as? [[String: Any]] ?? []).prefix(5).map(chapter)))
    }
    func catalog() async throws -> [Series] {
        var result: [Series] = [], seen = Set<String>()
        for endpoint in ["/home/latest", "/series"] {
            var page = 1
            while true {
                try Task.checkCancellation()
                let data = try await json("\(endpoint)?page=\(page)&perPage=\(endpoint == "/series" ? 100 : 50)")
                guard let rows = data["data"] as? [[String: Any]] else { throw ReaderError.message("Invalid catalog response") }
                for row in rows {
                    // The live catalog includes an unpublished row with an empty slug.
                    // Like Asura, omit entries that cannot identify an openable series.
                    guard let slug = row["slug"] as? String, CachePolicy.validSlug(slug) else { continue }
                    let series = try Self.series(row)
                    if seen.insert(series.slug).inserted { result.append(series) }
                }
                let next = data["next"] != nil && !(data["next"] is NSNull)
                if !next && page >= (data["totalPages"] as? Int ?? 1) { break }
                guard !rows.isEmpty, page < 10000 else { throw ReaderError.message("Invalid catalog pagination") }
                page += 1
            }
        }
        return result
    }
    func chapters(_ slug: String) async throws -> [Chapter] {
        var result: [Chapter] = [], page = 1
        while true {
            try Task.checkCancellation()
            let data = try await json("/series/\(slug)/chapters?perPage=100&page=\(page)")
            guard let rows = data["data"] as? [[String: Any]] else { throw ReaderError.message("Invalid chapter list") }
            result += try rows.map(Self.chapter)
            let next = data["next"] != nil && !(data["next"] is NSNull)
            if !next && page >= (data["totalPages"] as? Int ?? 1) { break }
            guard !rows.isEmpty, page < 10000 else { throw ReaderError.message("Invalid chapter pagination") }
            page += 1
        }
        return CachePolicy.ordered(result)
    }
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest {
        let data = try await json("/series/\(slug)/chapters/\(chapter)")
        guard data["isFree"] as? Bool == true, data["requiresPurchase"] as? Bool != true,
              let rows = data["images"] as? [[String: Any]], !rows.isEmpty,
              let series = data["series"] as? [String: Any], let title = series["title"] as? String else { throw ReaderError.message("This chapter is locked or unavailable") }
        let pages = try rows.map { row -> PageImage in
            guard let url = row["url"] as? String else { throw ReaderError.message("Invalid page URL") }
            return try NativeProviderData.image(url, width: row["width"] as? Double ?? 0, height: row["height"] as? Double ?? 0)
        }
        return Manifest(slug: slug, chapter: chapter, title: title, seriesID: "", chapterID: chapter, pages: pages, chapters: try await chapters(slug))
    }
}
