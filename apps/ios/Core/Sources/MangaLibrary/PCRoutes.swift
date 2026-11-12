import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KitNet

// The PC's Load/Save server from anywhere (server/README.md), the way Guidance reaches its PC
// (guidance apps/ios, GuidanceStore.request): the home address first, briefly, then the public
// route.
// - Home: only the bundled CA is trusted for that host (LocalTrust). A transport failure there
//   (unreachable, timed out, another machine at that address) moves the request to the public
//   route and skips home for 45 s, so away from home a dead address is not waited for on
//   every request.
// - Public: the system's certificate trust and a longer wait.
// - An HTTP status from either address is the PC's answer and final; it never moves a request
//   to the other address.
// - A write is sent once (see `put`).
// Without a public route this is the home address alone, as before.
@MainActor
public final class PCRoutes {
    // Seconds the home address is skipped after it failed.
    static let homeRetry: TimeInterval = 45
    // Seconds a request waits for home when the public route can still answer it, and when home
    // is all there is (no public route, or a write already bound for home): 5 s, as before.
    static let homeWait: TimeInterval = 2
    static let homeAlone: TimeInterval = 5

    struct Route {
        let base: URL
        let http: HTTPClient
        let isHome: Bool
    }

    let home: Route
    let away: Route?
    private let key: String
    private let now: @MainActor () -> Date
    private var homeFailed = Date.distantPast

    // `publicRoute` must be HTTPS (it carries the key); anything else is ignored.
    public init(home: URL, publicRoute: URL?, key: String, certificate: URL?, now: @escaping @MainActor () -> Date = { Date() },
                configure: (@Sendable (URLSessionConfiguration) -> Void)? = nil) {
        self.key = key
        self.now = now
        let away = publicRoute.flatMap { url -> Route? in
            guard url.scheme?.lowercased() == "https", url.host?.isEmpty == false else { return nil }
            return Route(base: url, http: HTTPClient(.init(connectionsPerHost: 2, requestTimeout: 15, resourceTimeout: 25, configure: configure)), isHome: false)
        }
        self.away = away
        // The short wait is the session's own, so it holds however a request is built.
        let trust = LocalTrust(host: home.host ?? "", certificate: certificate)
        self.home = Route(base: home, http: HTTPClient(.init(trust: trust, connectionsPerHost: 2, requestTimeout: away == nil ? Self.homeAlone : Self.homeWait,
                                                             resourceTimeout: Self.homeAlone, configure: configure)), isHome: true)
    }

    // A read: the first address that answers.
    public func get(_ resource: String) async throws -> HTTPResponse { try await reach(resource).response }

    // A write is sent once, to the address that just answered `probe` (a read), and never again
    // on the other address: the PC keeps its previous state beside the new one, and a write
    // that arrived but whose answer was lost, repeated, would replace that previous state with
    // a copy of the new one. A probe the PC refuses is the answer.
    public func put(_ resource: String, body: Data, probe: String) async throws -> HTTPResponse {
        let reached = try await reach(probe)
        guard (200..<300).contains(reached.response.status) else { return reached.response }
        return try await ask(reached.route, resource, method: "PUT", body: body, timeout: reached.route.isHome ? Self.homeAlone : nil)
    }

    private func reach(_ resource: String) async throws -> (response: HTTPResponse, route: Route) {
        guard let away else { return (try await ask(home, resource), home) }
        // A clock set back must not skip home for longer than 45 s.
        if !(0..<Self.homeRetry).contains(now().timeIntervalSince(homeFailed)) {
            do { return (try await ask(home, resource, timeout: Self.homeWait), home) }
            catch { guard Self.unreachable(error) else { throw error } }
        }
        return (try await ask(away, resource), away)
    }

    private func ask(_ route: Route, _ resource: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval? = nil) async throws -> HTTPResponse {
        do {
            return try await route.http.send(HTTPRequest(route.base.appendingPathComponent(resource), method: method,
                                                         headers: ["Content-Type": "application/json", "X-Reader-Backup-Key": key],
                                                         body: body, retry: .never, timeout: timeout, accept: Set(300...599)))
        } catch {
            if route.isHome, Self.unreachable(error) { homeFailed = now() }
            throw error
        }
    }

    // A status outside the accepted range is still the PC's answer, and a cancelled caller says
    // nothing about the address; every other error means the address did not answer. A rejected
    // certificate arrives as a cancelled request, which is why the caller's task is asked.
    private static func unreachable(_ error: Error) -> Bool { !(error is HTTPStatusError) && !Task.isCancelled }
}
