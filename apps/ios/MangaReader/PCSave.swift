import Foundation
import KitNet
import MangaLibrary

// The PC's copy of the reading state (server/backups.mjs, /api/reader-backups/manual/
// manga-reader/<site>): Save replaces the PC's copy with this phone's; Load replaces this
// phone's positions for the site with the PC's, even if older. Nothing is automatic. An
// unreachable PC hides the controls; requests give up after 5 seconds.
@MainActor
final class PCSave {
    private let base: URL
    private let key: String
    private let http: HTTPClient
    private let state: ReadingState
    private enum Operation {
        case idle
        case running(Task<Void, Error>)
    }
    private var operation = Operation.idle

    // Native/BackupConfig.json ({url, key}) and the PC's CA (Native/LocalCA.cer) are private
    // build inputs; without them there are no PC controls.
    init?(state: ReadingState) {
        guard let file = Bundle.main.url(forResource: "BackupConfig", withExtension: "json", subdirectory: "Native"),
              let config = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any],
              let url = (config["url"] as? String).flatMap(URL.init(string:)), let key = config["key"] as? String, !key.isEmpty else { return nil }
        base = url
        self.key = key
        self.state = state
        let trust = LocalTrust(host: url.host ?? "", certificate: Bundle.main.url(forResource: "LocalCA", withExtension: "cer", subdirectory: "Native"))
        http = HTTPClient(.init(trust: trust, connectionsPerHost: 2, requestTimeout: 5, resourceTimeout: 5))
    }

    private var path: URL { base.appendingPathComponent("api/reader-backups/manual/manga-reader/" + state.provider) }

    private func request(_ url: URL, method: String = "GET", body: Data? = nil) async throws -> HTTPResponse {
        try await http.send(HTTPRequest(url, method: method, headers: ["Content-Type": "application/json", "X-Reader-Backup-Key": key],
                                        body: body, retry: .never, accept: Set(300...599)))
    }

    func available() async -> Bool {
        guard let response = try? await request(path.appendingPathComponent("status")) else { return false }
        return (200..<300).contains(response.status)
    }

    func load() async throws { try await serialize { try await self.loadNow() } }
    func save() async throws { try await serialize { try await self.saveNow() } }

    private func serialize(_ work: @escaping @MainActor () async throws -> Void) async throws {
        if case .running(let task) = operation {
            _ = try? await task.value
            return try await serialize(work)
        }
        let task = Task { @MainActor in
            defer { self.operation = .idle }
            try await work()
        }
        operation = .running(task)
        try await task.value
    }

    private func loadNow() async throws {
        let response = try await request(path)
        if response.status == 404 { throw StoreError.invalid("No saved reading state on PC") }
        guard (200..<300).contains(response.status) else { throw StoreError.invalid("PC request failed") }
        try state.restore(response.data)
    }

    private func saveNow() async throws {
        let response = try await request(path, method: "PUT", body: try state.backup())
        guard (200..<300).contains(response.status) else { throw StoreError.invalid("PC request failed") }
    }
}
