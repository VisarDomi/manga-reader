import Foundation

protocol AsuraSource: ReaderSource {
    func request(_ path: String, method: String, body: Data?, token: String?) async throws -> Data
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String
    func prioritize(_ url: String) async
}
actor TransferGate {
    private var active = 0
    private var waiting: [(url: String, urgent: Bool, continuation: CheckedContinuation<Void, Never>)] = []
    func acquire(_ url: String, urgent: Bool) async throws {
        if active < 4 { active += 1 } else { await withCheckedContinuation { waiting.append((url, urgent, $0)) } }
        do { try Task.checkCancellation() } catch { release(); throw error }
    }
    func prioritize(_ url: String) { for i in waiting.indices where waiting[i].url == url { waiting[i].urgent = true } }
    func release() { if waiting.isEmpty { active -= 1 } else { waiting.remove(at: waiting.firstIndex(where: \.urgent) ?? 0).continuation.resume() } }
}
actor ReaderHTTP {
    private let apiBase: String
    private let origin: String
    private let session: URLSession
    private let gate = TransferGate()
    init(origin: String, apiBase: String) {
        self.apiBase = apiBase
        self.origin = origin
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 90
        config.httpMaximumConnectionsPerHost = 4
        session = URLSession(configuration: config)
    }
    func prioritize(_ url: String) async { await gate.prioritize(url) }
    func request(_ path: String, method: String = "GET", body: Data? = nil, token: String? = nil) async throws -> Data {
        guard path.hasPrefix("/"), let url = URL(string: apiBase + path) else { throw ReaderError.message("Invalid provider request") }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body
        request.setValue(origin, forHTTPHeaderField: "Referer")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw ReaderError.http(status) }
        return data
    }
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String {
        guard let url = URL(string: raw), url.scheme == "https", url.host != nil else { throw ReaderError.message("Invalid image URL") }
        try await gate.acquire(raw, urgent: urgent)
        do {
            var request = URLRequest(url: url)
            request.setValue(origin, forHTTPHeaderField: "Referer")
            let (temporary, response) = try await session.download(for: request)
            defer { try? FileManager.default.removeItem(at: temporary) }
            try Task.checkCancellation()
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  let mime = response.mimeType, mime.hasPrefix("image/"),
                  (try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) > 0 else { throw ReaderError.message("Image download failed") }
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: temporary, to: destination)
            try writeAtomically(Data(mime.utf8), destination.appendingPathExtension("mime"))
            await gate.release()
            return mime
        } catch { await gate.release(); throw error }
    }
}

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
    func catalog() async throws -> [Series] {
        var items: [Series] = []
        var seen = Set<String>()
        for offset in stride(from: 0, to: 10000, by: 50) {
            try Task.checkCancellation()
            let json = try object(await request("/series?sort=latest&order=desc&limit=50&offset=\(offset)", method: "GET", body: nil, token: nil))
            let rows = json["data"] as? [[String: Any]] ?? []
            for row in rows {
                let publicPath = row["public_url"] as? String ?? ""
                let slug = URL(string: publicPath)?.lastPathComponent ?? (row["slug"] as? String ?? "")
                guard CachePolicy.validSlug(slug), seen.insert(slug).inserted else { continue }
                items.append(Series(slug: slug, identity: CachePolicy.identity(slug), title: row["title"] as? String ?? slug,
                                    cover: row["cover"] as? String ?? "", chapters: chaptersFrom(row["latest_chapters"])))
            }
            if rows.isEmpty || (json["meta"] as? [String: Any])?["has_more"] as? Bool == false { break }
        }
        guard !items.isEmpty else { throw ReaderError.message("Asura's catalog is unavailable. Your saved library is still here.") }
        return items
    }
    func chapters(_ slug: String) async throws -> [Chapter] {
        let json = try object(await request("/series/\(slug)/chapters", method: "GET", body: nil, token: nil))
        return chaptersFrom(json["data"])
    }
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest {
        let json = try object(await request("/series/\(slug)/chapters/\(chapter)", method: "GET", body: nil, token: token))
        guard let data = json["data"] as? [String: Any], data["is_locked"] as? Bool != true,
          let row = data["chapter"] as? [String: Any], let series = data["series"] as? [String: Any],
          let pages = row["pages"] as? [[String: Any]], !pages.isEmpty else { throw ReaderError.message("This chapter is locked or unavailable on Asura.") }
        let images = try pages.map { page -> PageImage in
            guard let raw = page["url"] as? String, let url = URL(string: raw), url.scheme == "https", url.host != nil else { throw ReaderError.message("Invalid page URL") }
            let w = (page["width"] as? Double).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0
            let h = (page["height"] as? Double).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0
            return PageImage(url: raw, width: w, height: h)
        }
        return Manifest(slug: slug, chapter: chapter, title: series["title"] as? String ?? slug,
                    seriesID: CachePolicy.number(series["id"]), chapterID: CachePolicy.number(row["id"]),
                    pages: images, chapters: chaptersFrom(data["chapter_list"]))
    }
}
