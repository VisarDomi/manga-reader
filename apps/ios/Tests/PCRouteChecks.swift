import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KitNet
@testable import MangaLibrary

// A scripted transport for the PC's two addresses: each host (or "host METHOD") answers with an
// HTTP status, fails like a network would, or stays silent until the request is cancelled.
private final class PCProtocol: URLProtocol, @unchecked Sendable {
    enum Answer { case status(Int), failure(URLError.Code), silence }
    struct Seen: Equatable {
        var method: String
        var url: String
        var key: String?
        var timeout: TimeInterval
        var body: Data?
    }
    static let lock = NSLock()
    nonisolated(unsafe) static var answers: [String: Answer] = [:]
    // Answer bodies by URL; others answer {"from":"<host>"}.
    nonisolated(unsafe) static var bodies: [String: String] = [:]
    nonisolated(unsafe) static var seen: [Seen] = []

    static func script(_ answers: [String: Answer], bodies: [String: String] = [:]) { lock.withLock { self.answers = answers; self.bodies = bodies; seen = [] } }
    static func requests() -> [Seen] { lock.withLock { seen } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, method = request.httpMethod ?? "GET"
        // URLSession hands a protocol the body as a stream on Apple's platforms.
        let body = request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            return data
        }
        let (answer, reply) = Self.lock.withLock { () -> (Answer?, String?) in
            Self.seen.append(Seen(method: method, url: url.absoluteString, key: request.value(forHTTPHeaderField: "X-Reader-Backup-Key"),
                                  timeout: request.timeoutInterval, body: body))
            return (Self.answers[url.host! + " " + method] ?? Self.answers[url.host!], Self.bodies[url.absoluteString])
        }
        switch answer {
        case .status(let status):
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data((reply ?? "{\"from\":\"\(url.host!)\"}").utf8))
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case .silence, nil: break
        }
    }
    override func stopLoading() {}
}

// The PC's Load/Save from anywhere (PCRoutes): home first, the public route only when home does
// not answer, 45 s without home after that, an HTTP status final, a write sent once.
@MainActor
enum PCRouteChecks {
    static let home = "192.168.1.197", away = "pc.example.test"
    static let status = "api/reader-backups/manual/manga-reader/asurascans/status"
    static let state = "api/reader-backups/manual/manga-reader/asurascans"
    static let homeBase = "https://192.168.1.197:7711/", awayBase = "https://pc.example.test/manga/"

    final class Clock { var date = Date(timeIntervalSince1970: 1_800_000_000) }

    static func routes(_ clock: Clock, publicRoute: String? = "https://pc.example.test/manga") -> PCRoutes {
        PCRoutes(home: URL(string: "https://192.168.1.197:7711")!, publicRoute: publicRoute.flatMap(URL.init(string:)), key: "fixture-key",
                 certificate: nil, now: { clock.date }, configure: { $0.protocolClasses = [PCProtocol.self] })
    }

    // What was asked, in order: "GET home", "PUT away", ...
    static func asked() -> [String] {
        PCProtocol.requests().map { $0.method + " " + ($0.url.hasPrefix(homeBase) ? "home" : $0.url.hasPrefix(awayBase) ? "away" : $0.url) }
    }

    static func failure(_ work: () async throws -> HTTPResponse) async -> Error? {
        do { _ = try await work(); return nil } catch { return error }
    }

    static func thrown(_ work: () async throws -> Void) async -> Error? {
        do { try await work(); return nil } catch { return error }
    }

    static func run() async throws {
        try await homeFirst()
        try await statusIsFinal()
        try await transportFailureFallsBack()
        try await homeSkippedFor45Seconds()
        try await cancellationIsNotAFailure()
        try await writesAreSentOnce()
        try await withoutAPublicRoute()
        try await searchRequests()
    }

    // Home search (PCSearch): long requests sent once to the address that answered Load/Save's status.
    static func searchRequests() async throws {
        let searchStatus = "api/manga-reader/search/asurascans/status", search = "api/manga-reader/search/asurascans"
        var pc = routes(Clock())
        var client = PCSearch(routes: pc, provider: "asurascans")
        expect(pc.homeSlow.http.configuration.resourceTimeout == 150 && pc.awaySlow?.http.configuration.resourceTimeout == 150
               && pc.homeSlow.http.configuration.trust?.host == home && pc.awaySlow?.http.configuration.trust == nil,
               "Long requests have their own sessions with 150 s, the bundled CA for home only")
        PCProtocol.script([home: .status(200), away: .status(200)], bodies: [homeBase + searchStatus: "{\"ready\":true}"])
        var ready = await client.available()
        var seen = PCProtocol.requests()
        expect(ready && seen.map(\.url) == [homeBase + status, homeBase + searchStatus], "At home: Load/Save's status, then search's status at home")
        expect(seen[1].timeout == 100 && seen[1].key == "fixture-key", "The search status may take 100 s and carries the key")

        PCProtocol.script([home: .status(200), away: .status(200)], bodies: [homeBase + searchStatus: "{\"ready\":false}"])
        ready = await client.available()
        expect(!ready, "A PC whose model is not answering does not offer search")
        PCProtocol.script([home: .status(200), home + " GET": .status(200), away: .status(200)], bodies: [homeBase + searchStatus: "not json"])
        ready = await client.available()
        expect(!ready, "An unreadable status does not offer search")
        PCProtocol.script([home: .failure(.timedOut), away: .failure(.timedOut)])
        ready = await client.available()
        expect(!ready, "An unreachable PC does not offer search")

        pc = routes(Clock()); client = PCSearch(routes: pc, provider: "asurascans")
        PCProtocol.script([home: .failure(.cannotConnectToHost), away: .status(200)],
                          bodies: [awayBase + search: "{\"matches\":[{\"id\":\"lord\",\"confidence\":95}]}"])
        let matches = try await client.search("lord levels up", titles: [(id: "lord", title: "The Lord Who Levels Up by Devouring")])
        seen = PCProtocol.requests()
        expect(matches == [SearchMatch(id: "lord", confidence: 95)], "Away from home the search answers through the public route")
        expect(asked() == ["GET home", "GET away", "POST away"] && seen[2].url == awayBase + search && seen[2].timeout == 140, "once, allowed 140 s")
        let sent = try JSONSerialization.jsonObject(with: seen[2].body ?? Data()) as? [String: Any]
        expect(sent?["query"] as? String == "lord levels up" && (sent?["titles"] as? [[String: String]])?.first == ["id": "lord", "title": "The Lord Who Levels Up by Devouring"],
               "It sends the query and the catalog's titles")

        pc = routes(Clock()); client = PCSearch(routes: pc, provider: "asurascans")
        PCProtocol.script([home: .status(200), home + " POST": .failure(.timedOut), away: .status(200)])
        let error = await thrown { _ = try await client.search("x", titles: [(id: "a", title: "A")]) }
        expect((error as? URLError)?.code == .timedOut && asked() == ["GET home", "POST home"], "A search that times out at home is not repeated on the public route")
        PCProtocol.script([home: .status(200), away: .status(200)])
        _ = try await pc.get(status)
        expect(asked() == ["GET home"], "and a slow answer does not start the 45 s skip")

        PCProtocol.script([home: .status(200), home + " POST": .status(503), away: .status(200)])
        let refused = await thrown { _ = try await client.search("x", titles: [(id: "a", title: "A")]) }
        expect(refused != nil && asked() == ["GET home", "POST home"], "A refused search (503) is a failure, not an empty result")
        print("PASS: Home search asks the PC like Load/Save, with long requests sent once")
    }

    static func homeFirst() async throws {
        let pc = routes(Clock())
        PCProtocol.script([home: .status(200), away: .status(200)])
        let response = try await pc.get(status)
        let seen = PCProtocol.requests()
        expect(response.status == 200 && response.text.contains(home), "Home answers a request when it is reachable")
        expect(seen.map(\.url) == [homeBase + status], "Only the home address is asked while it answers")
        expect(seen[0].key == "fixture-key", "The home request carries the key")
        expect(seen[0].timeout == 2, "Home is given about 2 s when the public route can still answer")
        expect(pc.home.http.configuration.requestTimeout == 2 && pc.home.http.configuration.resourceTimeout == 5, "The home session itself waits 2 s, 5 s in all")
        expect(pc.home.http.configuration.trust?.host == home, "Only the home host uses the bundled CA")
        expect(pc.away?.http.configuration.trust == nil, "The public route uses the system's certificate trust")
        expect(pc.away?.http.configuration.requestTimeout == 15 && pc.away?.http.configuration.resourceTimeout == 25, "The public route waits longer")
        print("PASS: PC Load/Save asks home first, with the short wait and the bundled CA for that host only")
    }

    static func statusIsFinal() async throws {
        for code in [400, 401, 404, 413, 500, 502, 503] {
            let pc = routes(Clock())
            PCProtocol.script([home: .status(code), away: .status(200)])
            let response = try await pc.get(status)
            expect(response.status == code && asked() == ["GET home"], "Home's HTTP \(code) is the answer; the public route is not asked")
            let again = try await pc.get(status)
            expect(again.status == code && asked() == ["GET home", "GET home"], "An HTTP \(code) from home does not start the 45 s skip")

            PCProtocol.script([home: .failure(.cannotConnectToHost), away: .status(code)])
            let fallback = try await pc.get(status)
            expect(fallback.status == code && asked() == ["GET home", "GET away"], "The public route's HTTP \(code) is the answer")
        }
        print("PASS: an HTTP status from either PC address is final")
    }

    static func transportFailureFallsBack() async throws {
        // `.cancelled` is how a rejected certificate arrives (LocalTrust cancels the challenge).
        for code in [URLError.Code.timedOut, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet,
                     .secureConnectionFailed, .serverCertificateUntrusted, .cancelled] {
            let pc = routes(Clock())
            PCProtocol.script([home: .failure(code), away: .status(200)])
            let response = try await pc.get(state)
            let seen = PCProtocol.requests()
            expect(response.status == 200 && response.text.contains(away), "The public route answers when home fails with \(code.rawValue)")
            expect(seen.map(\.url) == [homeBase + state, awayBase + state], "Home first, then the same path under the public route's prefix (\(code.rawValue))")
            expect(seen.allSatisfy { $0.key == "fixture-key" && $0.method == "GET" }, "Both addresses get the same key and method")
            expect(seen[1].timeout != 2, "The public route is not held to home's short wait")
        }
        let pc = routes(Clock())
        PCProtocol.script([home: .failure(.timedOut), away: .failure(.notConnectedToInternet)])
        let error = await failure { try await pc.get(status) }
        expect((error as? URLError)?.code == .notConnectedToInternet && asked() == ["GET home", "GET away"], "With neither address answering the request fails")
        print("PASS: only a transport failure at home moves a PC request to the public route")
    }

    static func homeSkippedFor45Seconds() async throws {
        let clock = Clock(), pc = routes(clock)
        PCProtocol.script([home: .failure(.timedOut), away: .status(200)])
        _ = try await pc.get(status)
        expect(asked() == ["GET home", "GET away"], "The first request away from home tries home")
        let failed = clock.date
        for seconds in [1.0, 20, 44.9] {
            clock.date = failed + seconds
            PCProtocol.script([home: .status(200), away: .status(200)])
            let response = try await pc.get(status)
            expect(response.text.contains(away) && asked() == ["GET away"], "\(seconds) s after home failed only the public route is asked")
        }
        PCProtocol.script([home: .status(200), away: .failure(.timedOut)])
        let error = await failure { try await pc.get(status) }
        expect(error is URLError && asked() == ["GET away"], "A failing public route inside the 45 s is the failure; home is not asked")

        clock.date = failed + 45.1
        PCProtocol.script([home: .failure(.timedOut), away: .status(200)])
        _ = try await pc.get(status)
        expect(asked() == ["GET home", "GET away"], "After 45 s home is tried again")
        clock.date += 44
        _ = try await pc.get(status)
        expect(asked() == ["GET home", "GET away", "GET away"], "A second failure starts another 45 s")
        clock.date += 2
        PCProtocol.script([home: .status(200), away: .status(200)])
        let back = try await pc.get(status)
        expect(back.text.contains(home) && asked() == ["GET home"], "Back home, home answers again")
        _ = try await pc.get(status)
        expect(asked() == ["GET home", "GET home"], "and keeps answering")

        // A clock set back must not hide home for longer than 45 s.
        PCProtocol.script([home: .failure(.timedOut), away: .status(200)])
        _ = try await pc.get(status)
        clock.date -= 3600
        PCProtocol.script([home: .status(200), away: .status(200)])
        _ = try await pc.get(status)
        expect(asked() == ["GET home"], "A clock set back does not extend the skip")
        print("PASS: home is skipped for 45 s after it failed, then tried again")
    }

    static func cancellationIsNotAFailure() async throws {
        let pc = routes(Clock())
        PCProtocol.script([home: .silence, away: .status(200)])
        let request = Task { try await pc.get(status) }
        for _ in 0..<400 where PCProtocol.requests().isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        expect(asked() == ["GET home"], "The request waits for home")
        request.cancel()
        let result = await request.result
        expect((try? result.get()) == nil && asked() == ["GET home"], "A cancelled request fails without asking the public route")
        PCProtocol.script([home: .status(200), away: .status(200)])
        _ = try await pc.get(status)
        expect(asked() == ["GET home"], "A cancelled request does not start the 45 s skip")
        print("PASS: a cancelled PC request neither falls back nor marks home as failed")
    }

    static func writesAreSentOnce() async throws {
        let body = Data("{\"version\":1}".utf8)
        var pc = routes(Clock())
        PCProtocol.script([home: .status(200), away: .status(200)])
        var response = try await pc.put(state, body: body, probe: status)
        var seen = PCProtocol.requests()
        expect(response.status == 200 && seen.map(\.url) == [homeBase + status, homeBase + state] && asked() == ["GET home", "PUT home"],
               "At home a Save asks home for status, then writes there")
        expect(seen[1].body == body && seen[1].key == "fixture-key" && seen[1].timeout == 5, "The write carries the state and the key, with 5 s as before")

        pc = routes(Clock())
        PCProtocol.script([home: .failure(.timedOut), away: .status(200)])
        response = try await pc.put(state, body: body, probe: status)
        seen = PCProtocol.requests()
        expect(response.text.contains(away) && asked() == ["GET home", "GET away", "PUT away"], "Away from home a Save goes through the public route, once")
        expect(seen[2].url == awayBase + state && seen[2].body == body && seen[2].key == "fixture-key", "The public write carries the same state and key")

        // The write reached home or it did not: the phone cannot tell, so it must not repeat it.
        pc = routes(Clock())
        PCProtocol.script([home: .status(200), home + " PUT": .failure(.timedOut), away: .status(200)])
        var error = await failure { try await pc.put(state, body: body, probe: status) }
        expect((error as? URLError)?.code == .timedOut && asked() == ["GET home", "PUT home"], "A write that fails at home is not repeated on the public route")
        PCProtocol.script([home: .status(200), away: .status(200)])
        _ = try await pc.get(status)
        expect(asked() == ["GET away"], "A write that failed at home starts the 45 s skip like any home failure")

        pc = routes(Clock())
        PCProtocol.script([home: .failure(.cannotConnectToHost), away: .status(200), away + " PUT": .failure(.networkConnectionLost)])
        error = await failure { try await pc.put(state, body: body, probe: status) }
        expect((error as? URLError)?.code == .networkConnectionLost && asked() == ["GET home", "GET away", "PUT away"], "A write that fails on the public route is not repeated")

        for code in [401, 502] {
            pc = routes(Clock())
            PCProtocol.script([home: .status(code), away: .status(200)])
            response = try await pc.put(state, body: body, probe: status)
            expect(response.status == code && asked() == ["GET home"], "A refused status (\(code)) is the answer; no state is sent")
            PCProtocol.script([home: .status(200), home + " PUT": .status(code), away: .status(200)])
            response = try await pc.put(state, body: body, probe: status)
            expect(response.status == code && asked() == ["GET home", "PUT home"], "A refused write (\(code)) is the answer and is not repeated")
        }
        print("PASS: a PC Save is sent once, to the address that answered")
    }

    static func withoutAPublicRoute() async throws {
        for publicRoute in [nil, "http://pc.example.test/manga", "manga"] as [String?] {
            let pc = routes(Clock(), publicRoute: publicRoute)
            expect(pc.away == nil && pc.home.http.configuration.requestTimeout == 5, "Without an HTTPS public route there is only home, with 5 s as before")
            PCProtocol.script([home: .failure(.timedOut), away: .status(200)])
            var error = await failure { try await pc.get(status) }
            expect((error as? URLError)?.code == .timedOut && asked() == ["GET home"], "and a home failure is the failure")
            error = await failure { try await pc.get(status) }
            expect(error != nil && asked() == ["GET home", "GET home"], "and home is asked every time")
            expect(PCProtocol.requests().allSatisfy { $0.timeout != 2 }, "and home is not held to the short wait")
        }
        print("PASS: without a public route PC Load/Save is the home address alone")
    }
}
