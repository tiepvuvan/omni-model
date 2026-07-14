import FoundationModels
import Foundation

#if canImport(ImageIO)
  import CoreGraphics
  import ImageIO
#endif

/// Builds an OpenAI-compatible `/v1/chat/completions` request body from a
/// Foundation Models `Transcript`.
@available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *)
enum OpenAIRequest {
  static func make(
    model: String,
    transcript: Transcript,
    options: GenerationOptions
  ) throws -> [String: Any] {
    var messages: [[String: Any]] = []

    for entry in transcript {
      switch entry {
      case .instructions(let instructions):
        let text = plainText(instructions.segments)
        if !text.isEmpty { messages.append(["role": "system", "content": text]) }

      case .prompt(let prompt):
        messages.append(["role": "user", "content": try userContent(prompt.segments)])

      case .response(let response):
        messages.append(["role": "assistant", "content": plainText(response.segments)])

      case .toolOutput(let output):
        // No first-class tool support yet — fold the output back in as context.
        let text = plainText(output.segments)
        messages.append(["role": "user", "content": "[tool:\(output.toolName)] \(text)"])

      case .toolCalls, .reasoning:
        // Prior tool calls / reasoning are not replayed to the upstream model.
        continue

      @unknown default:
        continue
      }
    }

    var body: [String: Any] = [
      "model": model,
      "messages": messages,
      "stream": true,
      "stream_options": ["include_usage": true],
    ]
    if let temperature = options.temperature { body["temperature"] = temperature }
    if let maxTokens = options.maximumResponseTokens { body["max_completion_tokens"] = maxTokens }
    return body
  }

  /// Concatenate the text of a segment list, ignoring image attachments.
  static func plainText(_ segments: [Transcript.Segment]) -> String {
    segments.compactMap { segment -> String? in
      switch segment {
      case .text(let text): text.content
      case .structure(let structured): structured.description
      case .custom(let custom): custom.description
      case .attachment: nil
      @unknown default: nil
      }
    }.joined(separator: "\n")
  }

  /// User content: a plain string when text-only, or an array of OpenAI content
  /// parts when the prompt carries image attachments (vision).
  static func userContent(_ segments: [Transcript.Segment]) throws -> Any {
    var parts: [[String: Any]] = []
    var hasImage = false

    for segment in segments {
      switch segment {
      case .text(let text):
        parts.append(["type": "text", "text": text.content])
      case .structure(let structured):
        parts.append(["type": "text", "text": structured.description])
      case .custom(let custom):
        parts.append(["type": "text", "text": custom.description])
      case .attachment(let attachment):
        guard let url = imageURL(attachment.content) else {
          throw LanguageModelError.unsupportedTranscriptContent(
            .init(unsupportedContent: [], debugDescription: "could not encode an image attachment"))
        }
        parts.append(["type": "image_url", "image_url": ["url": url]])
        hasImage = true
      @unknown default:
        continue
      }
    }

    if !hasImage {
      return parts.compactMap { $0["text"] as? String }.joined(separator: "\n")
    }
    return parts
  }

  private static func imageURL(_ attachment: Transcript.Attachment) -> String? {
    switch attachment {
    case .image(let image):
      if let url = image.url, url.scheme == "http" || url.scheme == "https" || url.scheme == "data" {
        return url.absoluteString
      }
      #if canImport(ImageIO)
        if let base64 = pngBase64(image.cgImage) { return "data:image/png;base64,\(base64)" }
      #endif
      return nil
    @unknown default:
      return nil
    }
  }
}

#if canImport(ImageIO)
  /// PNG-encode a `CGImage` to a base64 string for a `data:` URL.
  func pngBase64(_ image: CGImage) -> String? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return (data as Data).base64EncodedString()
  }
#endif

/// Maps a non-2xx proxy response onto a `LanguageModelError` where one fits, or
/// an ``OmniModelError`` otherwise.
@available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *)
enum ErrorMapping {
  static func map(status: Int, body: Data) -> Error {
    let message = openAIMessage(body) ?? "upstream error \(status)"
    switch status {
    case 429:
      return LanguageModelError.rateLimited(.init(resetDate: nil, debugDescription: message))
    case 408, 504:
      return LanguageModelError.timeout(.init(debugDescription: message))
    case 400, 413:
      let lower = message.lowercased()
      if lower.contains("context") || lower.contains("maximum context") {
        return LanguageModelError.contextSizeExceeded(
          .init(contextSize: 0, tokenCount: 0, debugDescription: message))
      }
      return OmniModelError.upstream(status: status, message: message)
    case 403:
      return LanguageModelError.guardrailViolation(.init(debugDescription: message))
    default:
      return OmniModelError.upstream(status: status, message: message)
    }
  }

  private static func openAIMessage(_ data: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let error = object["error"] as? [String: Any],
      let message = error["message"] as? String
    else { return nil }
    return message
  }
}
