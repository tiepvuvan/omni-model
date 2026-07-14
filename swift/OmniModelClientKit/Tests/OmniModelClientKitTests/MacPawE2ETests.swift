import OpenAI
import XCTest

@testable import OmniModelClientKit

/// End-to-end tests for the MacPaw/OpenAI client + `OmniAuthMiddleware` against a
/// running omni-model proxy on `http://localhost:8788` (which forwards to a real
/// upstream). Skips itself when no server is reachable, so it stays green offline.
///
/// Run the whole chain with `e2e/run-swift-e2e.sh`.
final class MacPawE2ETests: XCTestCase {
  private let baseURL = "http://localhost:8788"
  private let model = "openai/gpt-4o-mini"

  private func makeClient() async throws -> OpenAI {
    let box = OmniAuthBox()
    // The E2E proxy has no auth; send a throwaway bearer it will ignore.
    try await box.refresh(from: BearerTokenAuth(staticToken: "e2e"))
    return OmniModel.makeOpenAI(endpoint: OmniEndpoint(baseURL), box: box)
  }

  func testChatThroughProxy() async throws {
    try await requireServer()
    let client = try await makeClient()
    let result = try await client.chats(
      query: ChatQuery(
        messages: [.user(.init(content: .string("Reply with exactly the word: pong")))],
        model: model
      )
    )
    let content = result.choices.first?.message.content ?? ""
    XCTAssertTrue(content.lowercased().contains("pong"), content)
  }

  func testStreamThroughProxy() async throws {
    try await requireServer()
    let client = try await makeClient()
    var text = ""
    for try await chunk in client.chatsStream(
      query: ChatQuery(
        messages: [.user(.init(content: .string("Count from 1 to 5, space-separated.")))],
        model: model
      )
    ) {
      for choice in chunk.choices { text += choice.delta.content ?? "" }
    }
    XCTAssertFalse(text.isEmpty)
  }

  // Tool calling is verified end-to-end at the proxy layer in the Node E2E
  // (`e2e/openrouter-chat.e2e.test.ts`), which exercises the same wire format.

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
