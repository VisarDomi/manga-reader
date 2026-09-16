import Foundation
import Security

// Only this LAN host may use the bundled PUBLIC local CA. TLS hostname and
// certificate validity are still evaluated; no accept-all certificate handler.
final class LocalTrust: NSObject, URLSessionDelegate, @unchecked Sendable {
    let host: String
    let certificateURL: URL?
    init(host: String, certificateURL: URL?) {
        self.host = host
        self.certificateURL = certificateURL
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host,
              let trust = challenge.protectionSpace.serverTrust,
              let certificateURL, let data = try? Data(contentsOf: certificateURL),
              let certificate = SecCertificateCreateWithData(nil, data as CFData)
        else { return (.performDefaultHandling, nil) }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        if SecTrustEvaluateWithError(trust, nil) {
            return (.useCredential, URLCredential(trust: trust))
        } else {
            return (.cancelAuthenticationChallenge, nil)
        }
    }
}
