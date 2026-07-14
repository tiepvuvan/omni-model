import FoundationModels
import XCTest

@testable import OmniModelFoundation

final class TranslationTests: XCTestCase {
  func testTranscriptMapsToOpenAIMessages() throws {
    guard #available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *) else {
      throw XCTSkip("The Foundation Models LanguageModel protocol requires OS 27.")
    }

    let transcript = Transcript(entries: [
      .instructions(.init(segments: [.text(.init(content: "You are helpful."))], toolDefinitions: [])),
      .prompt(.init(segments: [.text(.init(content: "Hello"))])),
      .response(.init(assetIDs: [], segments: [.text(.init(content: "Hi!"))])),
    ])

    let body = try OpenAIRequest.make(
      model: "gpt-4o-mini",
      transcript: transcript,
      options: GenerationOptions(temperature: 0.5, maximumResponseTokens: 100)
    )

    XCTAssertEqual(body["model"] as? String, "gpt-4o-mini")
    XCTAssertEqual(body["stream"] as? Bool, true)
    XCTAssertEqual(body["temperature"] as? Double, 0.5)
    XCTAssertEqual(body["max_completion_tokens"] as? Int, 100)

    let messages = try XCTUnwrap(body["messages"] as? [[String: Any]])
    XCTAssertEqual(messages.count, 3)
    XCTAssertEqual(messages[0]["role"] as? String, "system")
    XCTAssertEqual(messages[0]["content"] as? String, "You are helpful.")
    XCTAssertEqual(messages[1]["role"] as? String, "user")
    XCTAssertEqual(messages[1]["content"] as? String, "Hello")
    XCTAssertEqual(messages[2]["role"] as? String, "assistant")
    XCTAssertEqual(messages[2]["content"] as? String, "Hi!")
  }

  func testErrorMappingSurfacesLanguageModelError() throws {
    guard #available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *) else {
      throw XCTSkip("The Foundation Models LanguageModel protocol requires OS 27.")
    }
    let body = Data(#"{"error":{"message":"Rate limit reached","type":"rate_limit_error"}}"#.utf8)
    let error = ErrorMapping.map(status: 429, body: body)
    guard case LanguageModelError.rateLimited = error else {
      return XCTFail("expected .rateLimited, got \(error)")
    }
  }
}
