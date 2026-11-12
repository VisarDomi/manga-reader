import Foundation
import KitNet
import MangaLibrary

// The PC's copy of the reading state (server/backups.mjs, /api/reader-backups/manual/
// manga-reader/<site>): Save replaces the PC's copy with this phone's; Load replaces this
// phone's positions for the site with the PC's, even if older. Nothing is automatic. An
// unreachable PC hides the controls. The PC is asked at home first, then through its public
// route (PCRoutes, in MangaLibrary).
@MainActor
final class PCSave {
    private let routes: PCRoutes
    private let state: ReadingState
    private enum Operation {
        case idle
        case running(Task<Void, Error>)
    }
    private var operation = Operation.idle

    // Native/BackupConfig.json ({url, publicURL, key}: the home address, the public route, the
    // key for both) and the PC's CA (Native/LocalCA.cer) are private build inputs; without the
    // file there are no PC controls, without `publicURL` none away from home.
    init?(state: ReadingState) {
        guard let file = Bundle.main.url(forResource: "BackupConfig", withExtension: "json", subdirectory: "Native"),
              let config = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any],
              let url = (config["url"] as? String).flatMap(URL.init(string:)), let key = config["key"] as? String, !key.isEmpty else { return nil }
        self.state = state
        routes = PCRoutes(home: url, publicRoute: (config["publicURL"] as? String).flatMap(URL.init(string:)), key: key,
                          certificate: Bundle.main.url(forResource: "LocalCA", withExtension: "cer", subdirectory: "Native"))
    }

    private var path: String { "api/reader-backups/manual/manga-reader/" + state.provider }
    private var status: String { path + "/status" }

    func available() async -> Bool {
        guard let response = try? await routes.get(status) else { return false }
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
        let response = try await routes.get(path)
        if response.status == 404 { throw StoreError.invalid("No saved reading state on PC") }
        guard (200..<300).contains(response.status) else { throw StoreError.invalid("PC request failed") }
        try state.restore(response.data)
    }

    private func saveNow() async throws {
        let response = try await routes.put(path, body: try state.backup(), probe: status)
        guard (200..<300).contains(response.status) else { throw StoreError.invalid("PC request failed") }
    }
}
