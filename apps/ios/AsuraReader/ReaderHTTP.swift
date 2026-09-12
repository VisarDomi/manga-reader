import Foundation

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
