//
//  OmniModelClient.swift
//  Drop-in client for calling a self-hosted omni-model proxy from iOS,
//  built on MacPaw/OpenAI (https://github.com/MacPaw/OpenAI).
//
//  ─────────────────────────────────────────────────────────────────────────
//  HOW TO USE
//  ─────────────────────────────────────────────────────────────────────────
//  1. Add MacPaw/OpenAI via Swift Package Manager:
//        https://github.com/MacPaw/OpenAI  (Up to Next Major, from 0.4.0)
//  2. Copy this file into your app target.
//  3. Edit `OmniEndpoint.production` below to your deployed proxy URL.
//  4. Pick an auth provider that matches your proxy's `security.providers`
//     and make requests:
//
//        let client = OmniModelClient(auth: FirebaseAppCheckAuth())
//        let result = try await client.chat(
//            ChatQuery(messages: [.user(.init(content: .string("Hello!")))],
//                      model: "gpt-4o-mini")
//        )
//        print(result.choices.first?.message.content ?? "")
//
//  The provider API keys never touch the app — the proxy holds them. This file
//  only attaches the caller's identity (Firebase / App Check / App Attest /
//  DeviceCheck / custom JWT) as request headers, refreshed on every call.
//
//  Firebase providers compile only when the Firebase SDKs are present
//  (`#if canImport(...)`), so this file builds with just MacPaw/OpenAI.
//

import CryptoKit
import Foundation
import OpenAI

#if canImport(DeviceCheck)
  import DeviceCheck
#endif
#if canImport(FirebaseAuth)
  import FirebaseAuth
#endif
#if canImport(FirebaseAppCheck)
  import FirebaseAppCheck
#endif

// MARK: - Endpoint

/// Location of your deployed omni-model proxy. Split into parts because
/// MacPaw/OpenAI builds URLs from scheme/host/port/basePath.
public struct OmniEndpoint: Sendable {
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

  /// A URL rooted at the proxy origin (ignores `basePath`) — used for the
  /// App Attest challenge/register routes, which the proxy mounts outside `/v1`.
  func rootURL(path: String) -> URL {
    var c = URLComponents()
    c.scheme = scheme
    c.host = host
    if !(scheme == "https" && port == 443) && !(scheme == "http" && port == 80) {
      c.port = port
    }
    c.path = path
    guard let url = c.url else { fatalError("OmniEndpoint: invalid URL for path \(path)") }
    return url
  }

  // ───────────────────────────────────────────────────────────────────────
  // >>> EDIT ME <<<  Point this at your deployed omni-model proxy.
  // ───────────────────────────────────────────────────────────────────────
  public static let production = OmniEndpoint("https://your-proxy.example.com")
}

// MARK: - Auth

public enum OmniAuthError: Error {
  case notSignedIn
  case deviceCheckUnsupported
  case appAttestUnsupported
  case badResponse
  case httpError(status: Int, body: String)
}

/// Supplies the auth headers attached to each request. Called once per call so
/// short-lived tokens (Firebase ID tokens, App Attest assertions) stay fresh.
public protocol OmniAuthProvider: Sendable {
  func headers() async throws -> [String: String]
}

/// Any bearer token — a custom JWT, a Supabase access token, or your own auth.
/// Matches the proxy's `jwt` / `firebase-auth` / `supabase` verifiers.
public struct BearerTokenAuth: OmniAuthProvider {
  private let token: @Sendable () async throws -> String

  /// Fetch a fresh token on every call (recommended — tokens expire).
  public init(_ token: @escaping @Sendable () async throws -> String) {
    self.token = token
  }

  /// A fixed token (fine for testing; refresh in production).
  public init(staticToken value: String) {
    self.token = { value }
  }

  public func headers() async throws -> [String: String] {
    ["Authorization": "Bearer \(try await token())"]
  }
}

/// Attach an arbitrary custom header (for a custom `jwt` verifier configured
/// with a non-default `header`, or any bespoke scheme).
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

#if canImport(FirebaseAuth)
  /// Firebase Auth ID token → `Authorization: Bearer`. Matches the proxy's
  /// `firebase-auth` verifier (configured with your `projectId`).
  public struct FirebaseIDTokenAuth: OmniAuthProvider {
    private let forcingRefresh: Bool
    public init(forcingRefresh: Bool = false) { self.forcingRefresh = forcingRefresh }

    public func headers() async throws -> [String: String] {
      guard let user = Auth.auth().currentUser else { throw OmniAuthError.notSignedIn }
      let token = try await user.getIDTokenForcingRefresh(forcingRefresh)
      return ["Authorization": "Bearer \(token)"]
    }
  }
#endif

#if canImport(FirebaseAppCheck)
  /// Firebase App Check token → `X-Firebase-AppCheck`. Matches the proxy's
  /// `firebase-app-check` verifier (configured with your `projectNumber`).
  public struct FirebaseAppCheckAuth: OmniAuthProvider {
    private let forcingRefresh: Bool
    public init(forcingRefresh: Bool = false) { self.forcingRefresh = forcingRefresh }

    public func headers() async throws -> [String: String] {
      let token = try await AppCheck.appCheck().token(forcingRefresh: forcingRefresh)
      return ["X-Firebase-AppCheck": token.token]
    }
  }
#endif

#if canImport(DeviceCheck)
  /// Apple DeviceCheck token → `X-Apple-Device-Token`. Matches the proxy's
  /// `apple-device-check` verifier.
  public struct DeviceCheckAuth: OmniAuthProvider {
    public init() {}

    public func headers() async throws -> [String: String] {
      guard DCDevice.current.isSupported else { throw OmniAuthError.deviceCheckUnsupported }
      let token = try await DCDevice.current.generateToken()
      return ["X-Apple-Device-Token": token.base64EncodedString()]
    }
  }

  /// Apple App Attest. Matches the proxy's `apple-app-attest` verifier: on first
  /// use it generates a key, attests it, and registers it via the proxy's
  /// `/auth/app-attest/register` route; then every call fetches a one-time
  /// challenge from `/auth/app-attest/challenge` and signs an assertion over it.
  ///
  /// An `actor` so the one-time key generation/registration can't race.
  /// The key id is persisted in the Keychain (survives reinstall-free launches);
  /// swap the store for your own if you need stricter guarantees.
  @available(iOS 14.0, *)
  public actor AppAttestAuth: OmniAuthProvider {
    private let endpoint: OmniEndpoint
    private let session: URLSession
    private let service = DCAppAttestService.shared
    private let keychainAccount = "omni-model.appattest.keyId"
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
      // A key that's already been attested + registered this session: reuse it.
      if let keyId = Keychain.read(keychainAccount), registered { return keyId }

      let keyId: String
      if let existing = Keychain.read(keychainAccount) {
        keyId = existing
      } else {
        keyId = try await service.generateKey()
        try Keychain.write(keyId, account: keychainAccount)
      }

      // (Re)register: harmless if the key was already attested — the proxy
      // stores the credential idempotently.
      let challenge = try await fetchChallenge()
      let attestation = try await service.attestKey(keyId, clientDataHash: hash(challenge))
      try await register(keyId: keyId, attestation: attestation, challenge: challenge)
      registered = true
      return keyId
    }

    private func hash(_ challenge: String) -> Data {
      // The proxy computes clientDataHash = SHA-256(utf8(challenge)); match it.
      Data(SHA256.hash(data: Data(challenge.utf8)))
    }

    private func fetchChallenge() async throws -> String {
      var req = URLRequest(url: endpoint.rootURL(path: "/auth/app-attest/challenge"))
      req.httpMethod = "POST"
      let (data, resp) = try await session.data(for: req)
      try Self.checkOK(resp, data)
      guard let challenge = try JSONDecoder().decode([String: String].self, from: data)["challenge"]
      else { throw OmniAuthError.badResponse }
      return challenge
    }

    private func register(keyId: String, attestation: Data, challenge: String) async throws {
      var req = URLRequest(url: endpoint.rootURL(path: "/auth/app-attest/register"))
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

// MARK: - Client

/// A thin, `OpenAIProtocol`-backed client pointed at your omni-model proxy.
///
/// Each call fetches fresh auth headers from the provider, then delegates to a
/// MacPaw/OpenAI `OpenAI` instance configured for your proxy. `OpenAI` is the
/// real `OpenAIProtocol` implementation, so responses, models, and errors are
/// exactly what you'd get talking to OpenAI directly — only the base URL and
/// the auth headers differ.
public final class OmniModelClient: Sendable {
  private let endpoint: OmniEndpoint
  private let auth: OmniAuthProvider

  public init(endpoint: OmniEndpoint = .production, auth: OmniAuthProvider) {
    self.endpoint = endpoint
    self.auth = auth
  }

  private func makeClient(_ headers: [String: String]) -> OpenAI {
    // token: nil — the proxy holds the provider keys; our identity is in headers.
    OpenAI(
      configuration: .init(
        token: nil,
        host: endpoint.host,
        port: endpoint.port,
        scheme: endpoint.scheme,
        basePath: endpoint.basePath,
        customHeaders: headers
      )
    )
  }

  /// Non-streaming chat completion.
  public func chat(_ query: ChatQuery) async throws -> ChatResult {
    let client = makeClient(try await auth.headers())
    return try await client.chats(query: query)
  }

  /// Streaming chat completion. Auth headers are fetched before the stream opens.
  public func chatStream(_ query: ChatQuery) -> AsyncThrowingStream<ChatStreamResult, Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let client = makeClient(try await auth.headers())
          for try await result in client.chatsStream(query: query) {
            continuation.yield(result)
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  /// Embeddings.
  public func embeddings(_ query: EmbeddingsQuery) async throws -> EmbeddingsResult {
    let client = makeClient(try await auth.headers())
    return try await client.embeddings(query: query)
  }
}

// MARK: - Minimal Keychain helper (App Attest key id persistence)

private enum Keychain {
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
    let data = Data(value.utf8)
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)
    var add = base
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw OmniAuthError.httpError(status: Int(status), body: "keychain write failed")
    }
  }
}
