import Foundation

/// Errors from the proxy that don't map onto a built-in `LanguageModelError`.
/// Prefer catching `LanguageModelError` (rate limits, context overflow, timeouts,
/// guardrail violations); this covers the rest.
public enum OmniModelError: Error, LocalizedError {
  /// A non-2xx response the framework has no dedicated case for.
  case upstream(status: Int, message: String)
  /// The request never reached the proxy (connectivity, TLS, cancellation).
  case transportFailure(String)
  /// The proxy returned something that wasn't a valid HTTP/SSE response.
  case malformedResponse

  public var errorDescription: String? {
    switch self {
    case let .upstream(status, message): "omni-model proxy error \(status): \(message)"
    case let .transportFailure(detail): "could not reach the omni-model proxy: \(detail)"
    case .malformedResponse: "the omni-model proxy returned a malformed response"
    }
  }
}
