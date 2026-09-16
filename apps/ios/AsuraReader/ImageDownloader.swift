import Foundation

protocol ImageTransfer: Sendable {
    func image(_ url: String, to file: URL, referrer: String) async throws -> String
}

// The only image network/cache owner. Preparation and WebKit share the same jobs.
actor ImageDownloader {
    private struct Job {
        let url: String
        let cover: Bool
        var waiters: [UUID: CheckedContinuation<(Data, String), Error>] = [:]
    }
    private let root: URL
    private let transfer: any ImageTransfer
    private let referrer: String
    private var retained = Set<String>()
    private var jobs: [String: Job] = [:]
    private var queue: [String] = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var active = true
    private var scanned = false

    init(root: URL, transfer: any ImageTransfer, referrer: String) {
        self.root = root; self.transfer = transfer; self.referrer = referrer
    }
    private func key(_ url: String, _ cover: Bool) -> String { (cover ? "covers/" : "images/") + fileKey(url) }
    private func file(_ key: String) -> URL { root.appendingPathComponent(key) }
    private func cached(_ key: String) -> Bool {
        FileManager.default.fileExists(atPath: file(key).path) && FileManager.default.fileExists(atPath: file(key).appendingPathExtension("mime").path)
    }
    private func read(_ key: String) throws -> (Data, String) {
        (try Data(contentsOf: file(key), options: .mappedIfSafe), try String(contentsOf: file(key).appendingPathExtension("mime"), encoding: .utf8))
    }
    func image(_ url: String, cover: Bool) async throws -> (Data, String) {
        let key = key(url, cover), id = UUID()
        try Task.checkCancellation()
        if cached(key) { return try read(key) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if jobs[key] == nil { jobs[key] = Job(url: url, cover: cover); queue.append(key) }
                jobs[key]!.waiters[id] = continuation
                // An already queued background download is now visible work.
                pump()
            }
        } onCancel: { Task { await self.cancel(key, id: id) } }
    }
    private func cancel(_ key: String, id: UUID) {
        jobs[key]?.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
        discardUnused(); pump()
    }
    func setRetained(_ urls: Set<String>) throws {
        let removed = retained.subtracting(urls)
        retained = urls
        discardUnused()
        if !scanned {
            let keep = Set(urls.map { key($0, false) })
            let directory = root.appendingPathComponent("images")
            for entry in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
                let key = "images/" + entry.deletingPathExtension().lastPathComponent
                if !keep.contains(key), jobs[key] == nil { try FileManager.default.removeItem(at: entry) }
            }
            scanned = true
        } else {
            for url in removed {
                let key = key(url, false)
                if jobs[key] == nil {
                    try? FileManager.default.removeItem(at: file(key))
                    try? FileManager.default.removeItem(at: file(key).appendingPathExtension("mime"))
                }
            }
        }
        prepare()
    }
    func setActive(_ value: Bool) {
        active = value
        if active { prepare() } else { discardUnused() }
    }
    private func prepare() {
        guard active else { return }
        for url in retained.sorted() {
            let key = key(url, false)
            if jobs[key] == nil, !cached(key) { jobs[key] = Job(url: url, cover: false); queue.append(key) }
        }
        pump()
    }
    private func discardUnused() {
        for (key, job) in jobs where job.waiters.isEmpty && (!active || !retained.contains(job.url)) {
            if let task = tasks[key] { task.cancel() }
            else { jobs[key] = nil; queue.removeAll { $0 == key } }
        }
    }
    private func pump() {
        while !queue.isEmpty {
            let urgent = queue.firstIndex { !(jobs[$0]?.waiters.isEmpty ?? true) }
            guard tasks.count < (urgent == nil ? 3 : 4) else { return }
            let key = queue.remove(at: urgent ?? 0)
            guard let job = jobs[key] else { continue }
            tasks[key] = Task { [transfer, referrer] in
                do {
                    _ = try await transfer.image(job.url, to: file(key), referrer: referrer)
                    finish(key, error: nil)
                } catch { finish(key, error: error) }
            }
        }
    }
    private func finish(_ key: String, error: Error?) {
        tasks[key] = nil
        guard let job = jobs.removeValue(forKey: key) else { pump(); return }
        if !job.waiters.isEmpty {
            let result: Result<(Data, String), Error> = Result { if let error { throw error }; return try read(key) }
            for waiter in job.waiters.values { waiter.resume(with: result) }
        }
        if !job.cover && !retained.contains(job.url) {
            try? FileManager.default.removeItem(at: file(key))
            try? FileManager.default.removeItem(at: file(key).appendingPathExtension("mime"))
        }
        pump()
    }
    func diagnostics() -> [String: Int] { ["running": tasks.count, "queued": queue.count, "retained": retained.count] }
}
