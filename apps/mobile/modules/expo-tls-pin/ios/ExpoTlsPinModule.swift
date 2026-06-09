import ExpoModulesCore
import CryptoKit

public class ExpoTlsPinModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoTlsPin")

    AsyncFunction("request") { (args: [String: Any], promise: Promise) in
      guard
        let urlStr = args["url"] as? String,
        let url = URL(string: urlStr),
        let method = args["method"] as? String,
        let headers = args["headers"] as? [String: String],
        let fingerprint = args["fingerprint"] as? String
      else {
        promise.resolve(["ok": false, "kind": "network", "detail": "invalid args"])
        return
      }
      let body = args["body"] as? String

      var request = URLRequest(url: url)
      request.httpMethod = method
      for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
      if let body = body { request.httpBody = body.data(using: .utf8) }

      let delegate = PinningDelegate(
        expectedFingerprint: fingerprint.replacingOccurrences(of: ":", with: "").uppercased()
      )
      // Match Android OkHttp timeouts (see docs/phase-4-1-ios-prep.md H2).
      let config = URLSessionConfiguration.ephemeral
      config.timeoutIntervalForRequest = 30
      config.timeoutIntervalForResource = 30
      let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

      let task = session.dataTask(with: request) { data, response, error in
        // URLSession retains its delegate until invalidation; without this every
        // request leaks a session + PinningDelegate (Apple docs warn explicitly).
        defer { session.finishTasksAndInvalidate() }
        if let err = error as NSError? {
          if delegate.didMismatch {
            promise.resolve(["ok": false, "kind": "tls-mismatch", "detail": err.localizedDescription])
          } else {
            promise.resolve(["ok": false, "kind": "network", "detail": err.localizedDescription])
          }
          return
        }
        guard let http = response as? HTTPURLResponse, let data = data else {
          promise.resolve(["ok": false, "kind": "network", "detail": "no response"])
          return
        }
        var respHeaders: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
          if let ks = k as? String, let vs = v as? String { respHeaders[ks] = vs }
        }
        promise.resolve([
          "ok": true,
          "status": http.statusCode,
          "headers": respHeaders,
          "body": String(data: data, encoding: .utf8) ?? "",
        ])
      }
      task.resume()
    }
  }
}

class PinningDelegate: NSObject, URLSessionDelegate {
  let expectedFingerprint: String
  var didMismatch = false

  init(expectedFingerprint: String) {
    self.expectedFingerprint = expectedFingerprint
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let serverTrust = challenge.protectionSpace.serverTrust,
          let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
          let cert = chain.first
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    let der = SecCertificateCopyData(cert) as Data
    let digest = SHA256.hash(data: der)
    let hex = digest.map { String(format: "%02X", $0) }.joined()
    if hex == expectedFingerprint {
      // We pin by cert hash. SAN/CN check is bypassed because the desktop cert
      // is generated per-user with arbitrary CN; the SHA-256 fingerprint in the
      // pair QR is the identity. (Mirrors Android's hostnameVerifier { true }.)
      completionHandler(.useCredential, URLCredential(trust: serverTrust))
    } else {
      didMismatch = true
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }
}
