import FoundationModels
import XCTest

@testable import OmniModelFoundation

/// End-to-end tests against a running omni-model proxy on `http://localhost:8788`
/// (which forwards to a real upstream). They skip themselves when no server is
/// reachable, so the suite stays green offline.
///
/// Run the whole chain with `e2e/run-swift-e2e.sh` (boots the proxy, runs these
/// on the iOS 27 simulator, tears down). The simulator reaches the host's
/// `localhost`.
final class E2ETests: XCTestCase {
  private let baseURL = "http://localhost:8788"
  private let model = "openai/gpt-4o-mini"

  func testRespondThroughProxy() async throws {
    guard #available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *) else {
      throw XCTSkip("The Foundation Models LanguageModel protocol requires OS 27.")
    }
    try await requireServer()

    let model = OmniProxyModel(endpoint: OmniEndpoint(baseURL), model: self.model, auth: NoAuth())
    let session = LanguageModelSession(model: model) { "You are a terse assistant." }

    let reply = try await session.respond(to: "Reply with exactly the word: pong")
    XCTAssertFalse(reply.content.isEmpty)
    XCTAssertTrue(reply.content.lowercased().contains("pong"), reply.content)
  }

  func testStreamThroughProxy() async throws {
    guard #available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *) else {
      throw XCTSkip("The Foundation Models LanguageModel protocol requires OS 27.")
    }
    try await requireServer()

    let model = OmniProxyModel(endpoint: OmniEndpoint(baseURL), model: self.model, auth: NoAuth())
    let session = LanguageModelSession(model: model)

    // `respond`/`streamResponse` both drive the executor's SSE streaming path.
    let final = try await session.streamResponse(to: "Count from 1 to 5, space-separated.").collect()
    XCTAssertFalse(final.content.isEmpty)
  }

  /// Skip (don't fail) when there's no proxy to talk to.
  private func requireServer() async throws {
    var request = URLRequest(url: URL(string: "\(baseURL)/healthz")!)
    request.timeoutInterval = 3
    let reachable: Bool
    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      reachable = (response as? HTTPURLResponse)?.statusCode == 200
    } catch {
      reachable = false
    }
    if !reachable {
      throw XCTSkip("No omni-model server at \(baseURL). Run e2e/run-swift-e2e.sh.")
    }
  }
}
