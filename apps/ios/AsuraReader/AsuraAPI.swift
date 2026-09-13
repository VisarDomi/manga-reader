import Foundation

actor AsuraAPI: AsuraSource {
    private let http = ReaderHTTP(origin: ProviderConfiguration.asura.origin, apiBase: "https://api.asurascans.com/api")
    func request(_ path: String, method: String, body: Data?, token: String?) async throws -> Data {
        try await http.request(path, method: method, body: body, token: token)
    }
    func prioritize(_ url: String) async { await http.prioritize(url) }
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String {
        try await http.image(raw, to: destination, urgent: urgent)
    }
}

extension AsuraSource {
    static func coverURL(_ raw: String) -> String {
        guard !raw.isEmpty, let url = URL(string: raw, relativeTo: URL(string: ProviderConfiguration.asura.origin)), var parts = URLComponents(url: url.absoluteURL, resolvingAgainstBaseURL: true) else { return raw }
        if parts.path.contains("/covers/") && parts.path.hasSuffix(".webp") {
            parts.path = String(parts.path.dropLast(5)) + "-400.webp"
        }
        return parts.url?.absoluteString ?? raw
    }
    func catalog(onPage: CatalogUpdate?) async throws -> [Series] {
        var feed = CatalogFeed()
        for offset in stride(from: 0, to: 10000, by: 50) {
            try Task.checkCancellation()
            let json = try object(await request("/series?sort=latest&order=desc&limit=50&offset=\(offset)", method: "GET", body: nil, token: nil))
            guard let rows = json["data"] as? [[String: Any]] else { throw ReaderError.message("Invalid Asura catalog") }
            var items: [Series] = []
            for row in rows {
                let publicPath = row["public_url"] as? String ?? ""
                let slug = URL(string: publicPath)?.lastPathComponent ?? (row["slug"] as? String ?? "")
                guard CachePolicy.validSlug(slug) else { continue }
                items.append(Series(slug: slug, identity: CachePolicy.identity(slug), title: row["title"] as? String ?? slug,
                                    cover: Self.coverURL(row["cover"] as? String ?? ""), chapters: Array(chaptersFrom(row["latest_chapters"]).suffix(5))))
            }
            let meta = json["meta"] as? [String: Any]
            let more = meta?["has_more"] as? Bool == true
            try await feed.append(items, total: meta?["total"] as? Int, hasMore: more, onPage: onPage)
            if !more { break }
        }
        return feed.series
    }
    func chapters(_ slug: String) async throws -> [Chapter] {
        let json = try object(await request("/series/\(slug)/chapters", method: "GET", body: nil, token: nil))
        return chaptersFrom(json["data"])
    }
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest {
        let json = try object(await request("/series/\(slug)/chapters/\(chapter)", method: "GET", body: nil, token: token))
        guard let data = json["data"] as? [String: Any] else { throw ReaderError.message("Invalid Asura chapter") }
        if data["is_locked"] as? Bool == true { throw ReaderError.unavailable }
        guard
          let row = data["chapter"] as? [String: Any], let series = data["series"] as? [String: Any],
          let pages = row["pages"] as? [[String: Any]], !pages.isEmpty else { throw ReaderError.message("Invalid Asura chapter images") }
        let images = try pages.map { page -> PageImage in
            guard let raw = page["url"] as? String, let url = URL(string: raw), url.scheme == "https", url.host != nil else { throw ReaderError.message("Invalid page URL") }
            let w = (page["width"] as? Double).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0
            let h = (page["height"] as? Double).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0
            return PageImage(url: raw, width: w, height: h)
        }
        return Manifest(slug: slug, chapter: chapter, title: series["title"] as? String ?? slug,
                    seriesID: CachePolicy.number(series["id"]), chapterID: CachePolicy.number(row["id"]),
                    pages: images, chapters: [])
    }
}
