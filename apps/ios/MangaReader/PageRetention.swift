import Foundation

// Only page bytes expire. Covers and reading/chapter metadata are independent.
struct PageRetention: Codable, Sendable {
    static let grace: TimeInterval = 24 * 60 * 60
    var required = Set<String>()
    var expires: [String: Date] = [:]
    var migrationComplete = false

    mutating func reconcile(required next: Set<String>, existing: Set<String>, migrationGrace: Set<String>, now: Date) -> Set<String> {
        let legacy = migrationComplete ? [] : migrationGrace
        for name in required.subtracting(next).union(legacy).intersection(existing) where expires[name] == nil {
            expires[name] = now.addingTimeInterval(Self.grace)
        }
        required = next
        migrationComplete = true
        for name in next { expires[name] = nil }
        let remove = Set(existing.filter { !keeps($0, now: now) })
        expires = expires.filter { $0.value > now && existing.contains($0.key) }
        return remove
    }

    enum PageState: Equatable {
        case permanentCover, required, retired(until: Date), evictable
    }
    func state(of name: String, now: Date) -> PageState {
        if name.hasPrefix("covers/") { return .permanentCover }
        if required.contains(name) { return .required }
        if let deadline = expires[name], deadline > now { return .retired(until: deadline) }
        return .evictable
    }
    func keeps(_ name: String, now: Date) -> Bool { state(of: name, now: now) != .evictable }
}
