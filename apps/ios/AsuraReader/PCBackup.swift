import Foundation
import Security

// Only this LAN host may use the bundled PUBLIC local CA. TLS hostname and
// certificate validity are still evaluated; no accept-all certificate handler.
final class LocalTrust: NSObject, URLSessionDelegate, @unchecked Sendable {
    let host: String
    let certificateURL: URL?
    init(host: String, certificateURL: URL?) {
        self.host = host
        self.certificateURL = certificateURL
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host,
              let trust = challenge.protectionSpace.serverTrust,
              let certificateURL, let data = try? Data(contentsOf: certificateURL),
              let certificate = SecCertificateCreateWithData(nil, data as CFData)
        else { return (.performDefaultHandling, nil) }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        if SecTrustEvaluateWithError(trust, nil) {
            return (.useCredential, URLCredential(trust: trust))
        } else {
            return (.cancelAuthenticationChallenge, nil)
        }
    }
}

struct PCBackup: Sendable {
    private struct Config: Decodable { let url: String; let key: String }
    private let provider: ProviderConfiguration
    private let base: URL?
    private let key: String
    private let session: URLSession
    var configured: Bool { base != nil && !key.isEmpty }
    init(provider: ProviderConfiguration = .current) {
        self.provider = provider
        let file = Bundle.main.url(forResource: "BackupConfig", withExtension: "json", subdirectory: "Native")
        let config = file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        base = config.flatMap { URL(string: $0.url) }.flatMap { $0.scheme == "https" ? $0 : nil }
        key = config?.key ?? ""
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 4; settings.timeoutIntervalForResource = 6
        settings.urlCache = nil
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: settings,
            delegate: LocalTrust(host: base?.host ?? "", certificateURL: Bundle.main.url(forResource: "LocalCA", withExtension: "cer", subdirectory: "Native")), delegateQueue: queue)
    }
    private func request(method: String, body: Data? = nil, status: Bool = false) async throws -> Data {
        guard configured, let base else { throw ReaderError.message("PC unavailable") }
        var request = URLRequest(url: base.appendingPathComponent("api/reader-backups/manual/manga-reader/" + provider.rawValue + (status ? "/status" : "")))
        request.httpMethod = method; request.httpBody = body
        request.setValue(key, forHTTPHeaderField: "X-Reader-Backup-Key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ReaderError.message("PC unavailable") }
        if http.statusCode == 404 { throw ReaderError.message("No saved reading state on PC") }
        guard (200..<300).contains(http.statusCode) else { throw ReaderError.message("PC request failed") }
        return data
    }
    func available() async -> Bool { (try? await request(method: "GET", status: true)) != nil }
    func load() async throws -> Data { try await request(method: "GET") }
    func save(_ data: Data) async throws { _ = try await request(method: "PUT", body: data) }

}

enum BackupCodec {
    static func encode(_ state: AppState, provider: ProviderConfiguration = .current) throws -> Data {
        let progress: [[String: Any]] = state.progress.map { key, p in
            ["id": provider.rawValue + "\u{0}" + key, "provider": provider.rawValue, "seriesSlug": key, "chapterId": p.chapter,
             "imageIndex": p.page, "totalImages": p.total, "updatedAt": p.updatedAt]
        }
        let detail: [String: Any] = ["progress": try JSONSerialization.jsonObject(with: JSONEncoder().encode(state.progress)),
                                    "history": state.history]
        return try jsonData(["version": 1, "indexedDB": ["progress": progress,
            "tokens": state.tokens.map { ["key": $0.key, "value": $0.value] },
            "metadata": [["key": "progress-schema-version", "value": 3], ["key": provider.metadataKey, "value": detail]]]])
    }
    static func decode(_ data: Data, provider: ProviderConfiguration = .current) throws -> AppState {
        let root = try object(data)
        guard root["version"] as? Int == 1, let db = root["indexedDB"] as? [String: Any],
              let rows = db["progress"] as? [[String: Any]], let tokens = db["tokens"] as? [[String: Any]],
              let metadata = db["metadata"] as? [[String: Any]],
              metadata.contains(where: { $0["key"] as? String == "progress-schema-version" && $0["value"] as? Int == 3 }) else { throw ReaderError.message("Unsupported reading backup") }
        var state = AppState()
        for row in rows where row["provider"] as? String == provider.rawValue {
            guard let slug = row["seriesSlug"] as? String, CachePolicy.validSlug(slug),
                  let chapter = row["chapterId"] as? String, CachePolicy.validChapter(chapter),
                  let page = row["imageIndex"] as? Int, let total = row["totalImages"] as? Int,
                  total > 0, page >= 0, page < total, let date = row["updatedAt"] as? Double, date.isFinite,
                  row["id"] as? String == provider.rawValue + "\u{0}" + slug, state.progress[slug] == nil else { throw ReaderError.message("Invalid backup position") }
            let identity = provider.identity(slug)
            state.progress[identity] = Position(slug: slug, chapter: chapter, page: page, fraction: 0, total: total, updatedAt: date)
            state.history[identity, default: [:]][chapter] = page
        }
        if let detail = metadata.first(where: { $0["key"] as? String == provider.metadataKey })?["value"] as? [String: Any] {
            if let history = detail["history"] as? [String: [String: Int]] {
                for (slug, chapters) in history {
                    guard CachePolicy.validSlug(slug), chapters.allSatisfy({ CachePolicy.validChapter($0.key) && $0.value >= 0 }) else { throw ReaderError.message("Invalid backup history") }
                }
                state.history.merge(history) { old, new in old.merging(new, uniquingKeysWith: max) }
            }
            if let raw = detail["progress"], let values = try? JSONDecoder().decode([String: Position].self, from: jsonData(raw)) {
                for (key, p) in values {
                    if var base = state.progress[key], p.chapter == base.chapter, p.page == base.page, p.updatedAt == base.updatedAt,
                       p.fraction.isFinite, (0...1).contains(p.fraction) { base.fraction = p.fraction; state.progress[key] = base }
                }
            }
        }
        for token in tokens {
            if let key = token["key"] as? String, ["asura:access_token", "asura:refresh_token"].contains(key), let value = token["value"] as? String { state.tokens[key] = value }
        }
        return state
    }
}
