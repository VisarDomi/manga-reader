import Foundation

// Prepared chapters keep downloading while the app is away: locked, in the background, or closed
// by iOS. When the app leaves the screen, the downloader's unfinished pages (current chapters
// first) and covers go to a background URLSession, which iOS runs outside the app and which
// writes into the same cache files. Back on screen, the remaining transfers are cancelled and
// ImageDownloader, the cache's owner, carries on. Transfers are handed over while the app is
// still active: iOS defers ones started from the background at its discretion.
final class BackgroundDownloads: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let root: URL
    private let referrer: String
    private let lock = NSLock()
    // UIKit's completion handler, called once on the main thread.
    private struct Completion: @unchecked Sendable { let call: () -> Void }
    private var finishEvents: Completion?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: (Bundle.main.bundleIdentifier ?? "reader") + ".images")
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(root: URL, referrer: String) {
        self.root = root
        self.referrer = referrer
        super.init()
        _ = session // Reconnects to transfers that ran while the app was closed.
    }

    // iOS relaunched the app to deliver finished transfers; it waits for this handler.
    func handleEvents(_ completion: @escaping () -> Void) {
        lock.withLock { finishEvents = Completion(call: completion) }
        _ = session
    }

    func handOff(_ items: [(key: String, url: String)]) async {
        let running = Set(await session.allTasks.compactMap { $0.taskDescription.flatMap(Self.key) })
        for item in items where !running.contains(item.key) {
            guard let url = URL(string: item.url), url.scheme == "https" else { continue }
            var request = URLRequest(url: url)
            request.setValue(referrer, forHTTPHeaderField: "Referer")
            let task = session.downloadTask(with: request)
            task.taskDescription = item.key + "\n" + item.url
            task.resume()
        }
    }

    func reclaim() async {
        for task in await session.allTasks { task.cancel() }
    }

    private static func key(_ description: String) -> String? {
        let key = description.components(separatedBy: "\n").first ?? ""
        let parts = key.split(separator: "/")
        guard parts.count == 2, ["images", "covers"].contains(parts[0]), parts[1].allSatisfy(\.isHexDigit) else { return nil }
        return key
    }

    // As ReaderHTTP.image: a non-empty image, then its MIME file, which marks it complete.
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let key = downloadTask.taskDescription.flatMap(Self.key),
              let http = downloadTask.response as? HTTPURLResponse, http.statusCode == 200,
              let mime = http.mimeType, mime.hasPrefix("image/"),
              ((try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0 else { return }
        let file = root.appendingPathComponent(key)
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: file.appendingPathExtension("mime"))
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            try FileManager.default.moveItem(at: location, to: file)
            try writeAtomically(Data(mime.utf8), file.appendingPathExtension("mime"))
        } catch { print("Background image:", error.localizedDescription) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error as? URLError, error.code != .cancelled { print("Background image failed:", error.localizedDescription) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = lock.withLock { () -> Completion? in
            defer { finishEvents = nil }
            return finishEvents
        }
        if let completion { DispatchQueue.main.async { completion.call() } }
    }
}
