import Foundation

actor ReaderHTTP: ImageTransfer {
    private let session: URLSession
    private let images: URLSession
    init() {
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 90
        let file = Bundle.main.url(forResource: "BackupConfig", withExtension: "json", subdirectory: "Native")
        let settings = file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? object($0) }
        let host = (settings?["url"] as? String).flatMap { URL(string: $0)?.host } ?? ""
        images = URLSession(configuration: config, delegate: LocalTrust(host: host,
            certificateURL: Bundle.main.url(forResource: "LocalCA", withExtension: "cer", subdirectory: "Native")), delegateQueue: nil)
        // Metadata has its own connection pool; image preparation cannot occupy it.
        config.httpMaximumConnectionsPerHost = 8
        session = URLSession(configuration: config, delegate: LocalTrust(host: host,
            certificateURL: Bundle.main.url(forResource: "LocalCA", withExtension: "cer", subdirectory: "Native")), delegateQueue: nil)
    }
    func fetch(_ input: Data) async throws -> Data {
        let args = try object(input)
        guard let raw = args["url"] as? String, let url = URL(string: raw), url.scheme == "https", url.host != nil else { throw ReaderError.message("Invalid network URL") }
        var request = URLRequest(url: url)
        request.httpMethod = args["method"] as? String ?? "GET"
        if let body = args["body"] as? String { request.httpBody = Data(body.utf8) }
        for (key,value) in args["headers"] as? [String:String] ?? [:] { request.setValue(value, forHTTPHeaderField: key) }
        if let referrer = args["referrer"] as? String, referrer.hasPrefix("https://") { request.setValue(referrer, forHTTPHeaderField: "Referer") }
        let (data,response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ReaderError.message("Invalid HTTP response") }
        var headers: [String:String] = [:]
        for (key,value) in http.allHeaderFields { headers[String(describing:key)] = String(describing:value) }
        return try jsonData(["status":http.statusCode,"headers":headers,"body":data.base64EncodedString()])
    }
    func image(_ raw: String, to file: URL, referrer: String) async throws -> String {
        guard let url = URL(string: raw), url.scheme == "https", url.host != nil else { throw ReaderError.message("Invalid image URL") }
        do {
            var request = URLRequest(url:url); request.setValue(referrer, forHTTPHeaderField:"Referer")
            let (temporary,response) = try await images.download(for:request)
            defer { try? FileManager.default.removeItem(at:temporary) }
            try Task.checkCancellation()
            guard let http=response as? HTTPURLResponse, http.statusCode == 200,
                  let mime=http.mimeType, mime.hasPrefix("image/"),
                  (try temporary.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0)>0 else { throw ReaderError.message("Image download failed") }
            try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
            if FileManager.default.fileExists(atPath:file.path) { try FileManager.default.removeItem(at:file) }
            try FileManager.default.moveItem(at:temporary,to:file)
            try writeAtomically(Data(mime.utf8),file.appendingPathExtension("mime"))
            return mime
        } catch { throw error }
    }
}
