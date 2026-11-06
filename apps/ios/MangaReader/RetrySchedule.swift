import Foundation

struct RetrySchedule: Sendable, Equatable {
    enum Phase: Sendable, Equatable { case idle, waiting(until: Date, id: UUID) }
    private(set) var phase = Phase.idle
    mutating func schedule(_ deadline: Date) -> UUID? {
        if case .waiting(let existing, _) = phase, existing <= deadline { return nil }
        let id = UUID(); phase = .waiting(until: deadline, id: id); return id
    }
    mutating func fire(_ id: UUID) -> Bool {
        guard case .waiting(_, let current) = phase, current == id else { return false }
        phase = .idle; return true
    }
    mutating func cancel() { phase = .idle }
}
