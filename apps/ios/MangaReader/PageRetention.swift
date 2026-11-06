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

    func keeps(_ name: String, now: Date) -> Bool {
        name.hasPrefix("covers/") || required.contains(name) || expires[name].map { $0 > now } == true
    }
}
