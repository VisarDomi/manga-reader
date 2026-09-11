// Export only the identity named by SHA-1. Run in the logged-in Mac GUI session.
import Foundation
import Security
import CryptoKit

let args = CommandLine.arguments
guard args.count == 3 else { fatalError("Usage: export-identity SHA1 private-output-directory") }
let expected = args[1].uppercased()
let folder = URL(fileURLWithPath: args[2], isDirectory: true)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
var result: CFTypeRef?
let query: [String: Any] = [kSecClass as String: kSecClassIdentity, kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
let status = SecItemCopyMatching(query as CFDictionary, &result)
guard status == errSecSuccess, let identities = result as? [SecIdentity] else { fatalError("Identity lookup failed: \(status)") }
guard let identity = identities.first(where: { identity in
    var cert: SecCertificate?
    guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert else { return false }
    let hash = Insecure.SHA1.hash(data: SecCertificateCopyData(cert) as Data).map { String(format: "%02X", $0) }.joined()
    return hash == expected
}) else { fatalError("Requested signing identity not found") }
let password = UUID().uuidString + UUID().uuidString
let passphrase = password as CFString
var parameters = SecItemImportExportKeyParameters()
parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
parameters.passphrase = Unmanaged.passUnretained(passphrase)
var exported: CFData?
let exportedStatus = SecItemExport(identity, .formatPKCS12, [], &parameters, &exported)
guard exportedStatus == errSecSuccess, let exported else { fatalError("Selected identity export failed: \(exportedStatus)") }
for (name, data) in [("identity.p12", exported as Data), ("identity.password", Data(password.utf8))] {
    let path = folder.appendingPathComponent(name)
    try data.write(to: path, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
}
print("Exported selected signing identity to private local files.")
