//
//  OmniModelClient.swift
//  Auth transport for calling a self-hosted omni-model proxy from iOS with the
//  real MacPaw/OpenAI client (https://github.com/MacPaw/OpenAI).
//
//  ─────────────────────────────────────────────────────────────────────────
//  WHY A MIDDLEWARE (not a wrapper)
//  ─────────────────────────────────────────────────────────────────────────
//  You use MacPaw's `OpenAI` directly — its full API, its types, its updates.
//  This file only plugs an `OpenAIMiddleware` into it that attaches the caller's
//  identity (custom JWT / Firebase Auth / App Check / App Attest / DeviceCheck)
//  to every request, streaming and non-streaming alike. Nothing here forwards
//  `OpenAIProtocol` methods, so there is no thin wrapper to maintain and you get
//  MacPaw upgrades for free.
//
//  MacPaw's middleware runs synchronously, so headers come from a thread-safe
//  `OmniAuthBox` that you refresh asynchronously before a request:
//
//        let box = OmniAuthBox()
//        let openAI = OmniModel.makeOpenAI(box: box)     // a real MacPaw OpenAI
//        let auth = FirebaseAppCheckAuth()               // pick your provider
//
//        try await box.refresh(from: auth)               // cheap; required per-call for App Attest
//        let result = try await openAI.chats(
//            query: ChatQuery(messages: [.user(.init(content: .string("Hi")))],
//                             model: "gpt-4o-mini"))
//
//        // Streaming works the same — the middleware injects auth on the stream too:
//        try await box.refresh(from: auth)
//        for try await chunk in openAI.chatsStream(query: query) {
//            for c in chunk.choices { print(c.delta.content ?? "", terminator: "") }
//        }
//
//  ─────────────────────────────────────────────────────────────────────────
//  SETUP
//  ─────────────────────────────────────────────────────────────────────────
//  1. Add MacPaw/OpenAI via SPM: https://github.com/MacPaw/OpenAI (from 0.4.0).
//  2. Copy this file into your app target.
//  3. Edit `OmniEndpoint.production` below.
//  4. Pick the `OmniAuthProvider` matching your proxy's `security.providers`.
//
//  Firebase providers compile only when the Firebase SDKs are present
//  (`#if canImport(...)`), so this file builds with just MacPaw/OpenAI.
//

import CryptoKit
import Foundation
import OpenAI
import os

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

// MARK: - Auth box + middleware

/// Thread-safe holder for the auth headers the middleware injects. Written
/// asynchronously (via `refresh`), read synchronously by the middleware.
public final class OmniAuthBox: Sendable {
  private let state = OSAllocatedUnfairLock<[String: String]>(initialState: [:])

  public init() {}

  /// Replace the current headers with fresh ones from a provider.
  public func refresh(from provider: OmniAuthProvider) async throws {
    let next = try await provider.headers()
    state.withLock { $0 = next }
  }

  /// Set headers directly (e.g. from your own auth layer).
  public func set(_ headers: [String: String]) {
    state.withLock { $0 = headers }
  }

  func snapshot() -> [String: String] {
    state.withLock { $0 }
  }
}

/// A MacPaw `OpenAIMiddleware` that stamps the current auth headers onto every
/// request — including streaming requests (MacPaw applies `intercept(request:)`
/// to both). This is the whole integration: no `OpenAIProtocol` methods are
/// reimplemented.
public struct OmniAuthMiddleware: OpenAIMiddleware {
  private let box: OmniAuthBox

  public init(box: OmniAuthBox) { self.box = box }

  public func intercept(request: URLRequest) -> URLRequest {
    var request = request
    for (name, value) in box.snapshot() {
      request.setValue(value, forHTTPHeaderField: name)
    }
    return request
  }
}

/// Build a real MacPaw `OpenAI` pointed at your proxy, with the auth middleware
/// installed. The returned value is an ordinary `OpenAI` — use its full API.
public enum OmniModel {
  public static func makeOpenAI(endpoint: OmniEndpoint = .production, box: OmniAuthBox) -> OpenAI {
    OpenAI(
      configuration: .init(
        // token: nil — the proxy holds the provider keys; identity is in headers.
        token: nil,
        host: endpoint.host,
        port: endpoint.port,
        scheme: endpoint.scheme,
        basePath: endpoint.basePath
      ),
      middlewares: [OmniAuthMiddleware(box: box)]
    )
  }
}

// MARK: - Auth providers

public enum OmniAuthError: Error {
  case notSignedIn
  case deviceCheckUnsupported
  case appAttestUnsupported
  case badResponse
  case httpError(status: Int, body: String)
}

/// Produces the auth headers for one request. Called by `OmniAuthBox.refresh`.
public protocol OmniAuthProvider: Sendable {
  func headers() async throws -> [String: String]
}

/// Any bearer token — a custom JWT, a Supabase access token, or your own auth.
/// Matches the proxy's `jwt` / `firebase-auth` / `supabase` verifiers.
public struct BearerTokenAuth: OmniAuthProvider {
  private let token: @Sendable () async throws -> String

  public init(_ token: @escaping @Sendable () async throws -> String) { self.token = token }
  public init(staticToken value: String) { self.token = { value } }

  public func headers() async throws -> [String: String] {
    ["Authorization": "Bearer \(try await token())"]
  }
}

/// Attach an arbitrary custom header (for a `jwt` verifier configured with a
/// non-default `header`, or any bespoke scheme).
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
  /// `firebase-auth` verifier.
  public struct FirebaseIDTokenAuth: OmniAuthProvider {
    private let forcingRefresh: Bool
    public init(forcingRefresh: Bool = false) { self.forcingRefresh = forcingRefresh }

    public func headers() async throws -> [String: String] {
      guard let user = Auth.auth().currentUser else { throw OmniAuthError.notSignedIn }
      // `getIDTokenForcingRefresh` has an optional completion handler, so Swift
      // doesn't synthesize an async variant — bridge it explicitly.
      let token: String = try await withCheckedThrowingContinuation { continuation in
        user.getIDTokenForcingRefresh(forcingRefresh) { token, error in
          if let token {
            continuation.resume(returning: token)
          } else {
            continuation.resume(throwing: error ?? OmniAuthError.badResponse)
          }
        }
      }
      return ["Authorization": "Bearer \(token)"]
    }
  }
#endif

#if canImport(FirebaseAppCheck)
  /// Firebase App Check token → `X-Firebase-AppCheck`. Matches the proxy's
  /// `firebase-app-check` verifier. (App Check is itself backed by App Attest on
  /// modern devices — a good streaming-friendly choice for Firebase apps.)
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

  /// Apple App Attest. Matches the proxy's `apple-app-attest` verifier. Each
  /// `headers()` fetches a one-time challenge from the proxy and signs a fresh
  /// assertion over it, so **refresh the box immediately before every request**
  /// (the assertion is single-use). The one-time attest/register handshake runs
  /// automatically on first use.
  ///
  /// An `actor` so key generation/registration can't race. The key id is kept in
  /// the Keychain.
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
      if let keyId = Keychain.read(keychainAccount), registered { return keyId }

      let keyId: String
      if let existing = Keychain.read(keychainAccount) {
        keyId = existing
      } else {
        keyId = try await service.generateKey()
        try Keychain.write(keyId, account: keychainAccount)
      }

      // (Re)register: harmless if already attested — the proxy stores the
      // credential idempotently.
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
