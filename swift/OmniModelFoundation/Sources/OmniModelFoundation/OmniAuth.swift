import CryptoKit
import Foundation

#if canImport(DeviceCheck)
  import DeviceCheck
#endif

// MARK: - Endpoint

/// Location of your deployed omni-model proxy.
public struct OmniEndpoint: Hashable, Sendable {
  public var scheme: String
  public var host: String
  public var port: Int
  public var basePath: String

  public init(scheme: String = "https", host: String, port: Int = 443, basePath: String = "/v1") {
    self.scheme = scheme
    self.host = host
    self.port = port
    self.basePath = basePath
  }

  /// Parse from a URL string, e.g. `OmniEndpoint("https://ai.example.com")`.
  public init(_ urlString: String, basePath: String = "/v1") {
    let url = URL(string: urlString)
    self.scheme = url?.scheme ?? "https"
    self.host = url?.host ?? urlString
    self.port = url?.port ?? (self.scheme == "http" ? 80 : 443)
    self.basePath = basePath
  }

  /// The `/v1/chat/completions` URL.
  func chatCompletionsURL() -> URL { url(path: basePath + "/chat/completions") }

  /// A URL for a path rooted at the proxy origin.
  func url(path: String) -> URL {
    var c = URLComponents()
    c.scheme = scheme
    c.host = host
    if !(scheme == "https" && port == 443) && !(scheme == "http" && port == 80) {
      c.port = port
    }
    c.path = path
    guard let url = c.url else { preconditionFailure("OmniEndpoint: invalid URL for path \(path)") }
    return url
  }

  // >>> EDIT ME <<< the default proxy used when you don't pass one explicitly.
  public static let production = OmniEndpoint("https://your-proxy.example.com")
}

// MARK: - Auth providers

public enum OmniAuthError: Error {
  case notSignedIn
  case deviceCheckUnsupported
  case appAttestUnsupported
  case badResponse
  case httpError(status: Int, body: String)
}

/// Produces the auth headers attached to each request to the proxy. Called once
/// per generation, so short-lived tokens (App Attest assertions) stay fresh.
public protocol OmniAuthProvider: Sendable {
  func headers() async throws -> [String: String]
}

/// Any bearer token — a custom JWT, a Supabase access token, or a Firebase Auth
/// ID token. Matches the proxy's `jwt` / `firebase-auth` / `supabase` verifiers.
public struct BearerTokenAuth: OmniAuthProvider {
  private let token: @Sendable () async throws -> String
  public init(_ token: @escaping @Sendable () async throws -> String) { self.token = token }
  public init(staticToken value: String) { self.token = { value } }
  public func headers() async throws -> [String: String] {
    ["Authorization": "Bearer \(try await token())"]
  }
}

/// An arbitrary custom header — e.g. `X-Firebase-AppCheck` (fetch the App Check
/// token yourself and pass it here) for the proxy's `firebase-app-check` verifier.
public struct CustomHeaderAuth: OmniAuthProvider {
  private let name: String
  private let value: @Sendable () async throws -> String
  public init(header name: String, _ value: @escaping @Sendable () async throws -> String) {
    self.name = name
    self.value = value
  }
  public func headers() async throws -> [String: String] {
    [name: try await value()]
  }
}

/// No auth (a proxy with no `security.providers`). Do not use for a public proxy.
public struct NoAuth: OmniAuthProvider {
  public init() {}
  public func headers() async throws -> [String: String] { [:] }
}

#if canImport(DeviceCheck)
  /// Apple DeviceCheck → `X-Apple-Device-Token`. Matches `apple-device-check`.
  public struct DeviceCheckAuth: OmniAuthProvider {
    public init() {}
    public func headers() async throws -> [String: String] {
      guard DCDevice.current.isSupported else { throw OmniAuthError.deviceCheckUnsupported }
      let token = try await DCDevice.current.generateToken()
      return ["X-Apple-Device-Token": token.base64EncodedString()]
    }
  }

  /// Apple App Attest → `x-appattest-*`. Matches the `apple-app-attest` verifier:
  /// runs the one-time attest/register handshake on first use, then signs a fresh
  /// assertion over a one-time challenge from the proxy on every call.
  @available(iOS 14.0, macOS 11.0, visionOS 1.0, *)
  public actor AppAttestAuth: OmniAuthProvider {
    private let endpoint: OmniEndpoint
    private let session: URLSession
    private let service = DCAppAttestService.shared
    private let keychainAccount = "omni-model.foundation.appattest.keyId"
    private var registered = false

    public init(endpoint: OmniEndpoint = .production, session: URLSession = .shared) {
      self.endpoint = endpoint
      self.session = session
    }

    public func headers() async throws -> [String: String] {
      guard service.isSupported else { throw OmniAuthError.appAttestUnsupported }
      let keyId = try await ensureRegisteredKey()
      let challenge = try await fetchChallenge()
      let assertion = try await service.generateAssertion(keyId, clientDataHash: hash(challenge))
      return [
        "x-appattest-keyid": keyId,
        "x-appattest-assertion": assertion.base64EncodedString(),
        "x-appattest-challenge": challenge,
      ]
    }

    private func ensureRegisteredKey() async throws -> String {
      if let keyId = Keychain.read(keychainAccount), registered { return keyId }
      let keyId: String
      if let existing = Keychain.read(keychainAccount) {
        keyId = existing
      } else {
        keyId = try await service.generateKey()
        try Keychain.write(keyId, account: keychainAccount)
      }
      let challenge = try await fetchChallenge()
      let attestation = try await service.attestKey(keyId, clientDataHash: hash(challenge))
      try await register(keyId: keyId, attestation: attestation, challenge: challenge)
      registered = true
      return keyId
    }

    private func hash(_ challenge: String) -> Data {
      Data(SHA256.hash(data: Data(challenge.utf8)))
    }

    private func fetchChallenge() async throws -> String {
      var req = URLRequest(url: endpoint.url(path: "/auth/app-attest/challenge"))
      req.httpMethod = "POST"
      let (data, resp) = try await session.data(for: req)
      try Self.checkOK(resp, data)
      guard let challenge = try JSONDecoder().decode([String: String].self, from: data)["challenge"]
      else { throw OmniAuthError.badResponse }
      return challenge
    }

    private func register(keyId: String, attestation: Data, challenge: String) async throws {
      var req = URLRequest(url: endpoint.url(path: "/auth/app-attest/register"))
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: [
        "keyId": keyId,
        "attestation": attestation.base64EncodedString(),
        "challenge": challenge,
      ])
      let (data, resp) = try await session.data(for: req)
      try Self.checkOK(resp, data)
    }

    private static func checkOK(_ resp: URLResponse, _ data: Data) throws {
      guard let http = resp as? HTTPURLResponse else { throw OmniAuthError.badResponse }
      guard (200..<300).contains(http.statusCode) else {
        throw OmniAuthError.httpError(status: http.statusCode, body: String(decoding: data, as: UTF8.self))
      }
    }
  }
#endif

// MARK: - Keychain helper

enum Keychain {
  static func read(_ account: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(decoding: data, as: UTF8.self)
  }

  static func write(_ value: String, account: String) throws {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)
    var add = base
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw OmniAuthError.httpError(status: Int(status), body: "keychain write failed")
    }
  }
}
