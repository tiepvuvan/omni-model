import FoundationModels
import Foundation

// MARK: - LanguageModel

/// A ``FoundationModels/LanguageModel`` backed by a self-hosted omni-model proxy.
///
/// Construct it with your proxy endpoint, the model id/alias to request, and an
/// ``OmniAuthProvider``, then use it anywhere a `LanguageModel` is accepted:
///
/// ```swift
/// let model = OmniProxyModel(
///   endpoint: OmniEndpoint("https://ai.example.com"),
///   model: "gpt-4o-mini",
///   auth: BearerTokenAuth { try await myAuth.token() })
/// let session = LanguageModelSession(model: model)
/// let reply = try await session.respond(to: "Hello!")
/// ```
@available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *)
public struct OmniProxyModel: LanguageModel {
  public typealias Executor = OmniProxyExecutor

  let configuration: OmniProxyExecutor.Configuration
  /// The model name/alias sent to the proxy (routing decides the real upstream).
  public let modelName: String

  public init(endpoint: OmniEndpoint = .production, model: String, auth: any OmniAuthProvider) {
    self.configuration = .init(endpoint: endpoint, auth: OmniAuthHandle(auth))
    self.modelName = model
  }

  /// omni-model proxies vision-capable models, so images in a prompt are
  /// forwarded as data URLs. Guided generation and tool calling are handled by
  /// the upstream model but not advertised as first-class capabilities here.
  public var capabilities: LanguageModelCapabilities {
    LanguageModelCapabilities(capabilities: [.vision])
  }

  public var executorConfiguration: OmniProxyExecutor.Configuration { configuration }
}

/// A `Hashable`, `Sendable` identity box for an ``OmniAuthProvider`` so it can
/// live inside the executor's `Configuration` (the framework caches one executor
/// per unique configuration). Equality is by reference — reuse the same handle to
/// share an executor across models.
public final class OmniAuthHandle: Hashable, Sendable {
  let provider: any OmniAuthProvider
  public init(_ provider: any OmniAuthProvider) { self.provider = provider }
  public static func == (lhs: OmniAuthHandle, rhs: OmniAuthHandle) -> Bool { lhs === rhs }
  public func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }
}

// MARK: - LanguageModelExecutor

/// Runs generation for ``OmniProxyModel`` by translating the transcript into an
/// OpenAI chat-completions request, streaming the SSE response, and forwarding
/// text/usage back through the channel. Server-backed and stateless, so there is
/// no weight loading and `prewarm` is a no-op.
@available(iOS 27.0, macOS 27.0, visionOS 27.0, watchOS 27.0, *)
public struct OmniProxyExecutor: LanguageModelExecutor {
  public typealias Model = OmniProxyModel

  public struct Configuration: Hashable, Sendable {
    public var endpoint: OmniEndpoint
    public var auth: OmniAuthHandle
  }

  let configuration: Configuration
  private let session: URLSession

  public init(configuration: Configuration) throws {
    self.configuration = configuration
    self.session = .shared
  }

  public func prewarm(model: OmniProxyModel, transcript: Transcript) {
    // Nothing to warm for a server-backed model.
  }

  public nonisolated func respond(
    to request: LanguageModelExecutorGenerationRequest,
    model: OmniProxyModel,
    streamingInto channel: LanguageModelExecutorGenerationChannel
  ) async throws {
    let body = try OpenAIRequest.make(
      model: model.modelName,
      transcript: request.transcript,
      options: request.generationOptions
    )

    var urlRequest = URLRequest(url: configuration.endpoint.chatCompletionsURL())
    urlRequest.httpMethod = "POST"
    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    for (name, value) in try await configuration.auth.provider.headers() {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }
    urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)

    // Send request metadata up front so the app can log/debug immediately.
    await channel.send(.response(action: .updateMetadata(["requestID": request.id.uuidString])))

    let (bytes, response): (URLSession.AsyncBytes, URLResponse)
    do {
      (bytes, response) = try await session.bytes(for: urlRequest)
    } catch {
      throw OmniModelError.transportFailure(error.localizedDescription)
    }

    guard let http = response as? HTTPURLResponse else {
      throw OmniModelError.malformedResponse
    }
    if http.statusCode != 200 {
      // Drain the (short) error body and map it to a LanguageModelError.
      var raw = Data()
      for try await byte in bytes { raw.append(byte) }
      throw ErrorMapping.map(status: http.statusCode, body: raw)
    }

    // Stream SSE: each `data:` line is a chat.completion.chunk; `[DONE]` ends it.
    var sawModelMetadata = false
    for try await line in bytes.lines {
      guard line.hasPrefix("data:") else { continue }
      let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
      if payload == "[DONE]" { break }
      guard let data = payload.data(using: .utf8),
        let chunk = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { continue }

      if !sawModelMetadata, let responseModel = chunk["model"] as? String {
        sawModelMetadata = true
        await channel.send(.response(action: .updateMetadata(["model": responseModel])))
      }

      if let choices = chunk["choices"] as? [[String: Any]],
        let delta = choices.first?["delta"] as? [String: Any],
        let content = delta["content"] as? String, !content.isEmpty
      {
        await channel.send(.response(action: .appendText(content, tokenCount: 0)))
      }

      if let usage = chunk["usage"] as? [String: Any] {
        let prompt = usage["prompt_tokens"] as? Int ?? 0
        let completion = usage["completion_tokens"] as? Int ?? 0
        await channel.send(
          .response(
            action: .updateUsage(
              input: .init(totalTokenCount: prompt, cachedTokenCount: 0),
              output: .init(totalTokenCount: completion, reasoningTokenCount: 0)
            )))
      }
    }
  }
}
