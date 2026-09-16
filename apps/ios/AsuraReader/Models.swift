import Foundation
import CryptoKit

enum ReaderError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
func object(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ReaderError.message("Invalid native request") }
    return value
}
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]) }
func fileKey(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format:"%02x",$0) }.joined() }
func writeAtomically(_ data: Data, _ file: URL) throws {
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: file, options: .atomic)
}
