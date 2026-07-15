import Foundation
import SwiftUI

#if canImport(FirebaseAuth)
  import FirebaseAuth
#endif

/// On-device verification of every auth method omni-model supports, against a
/// running proxy. Each row obtains a credential from one `OmniAuthProvider`
/// (Firebase Auth / App Check / DeviceCheck / App Attest — the same providers
/// the MacPaw `OmniAuthMiddleware` injects in production) and sends a request to
/// `/v1/chat/completions`, then classifies the proxy's HTTP status:
///
///   200  → PASS     the credential was accepted and the chat completed
///   401  → FAIL     the proxy rejected the credential
///   else → AUTH OK  the credential was accepted (the request passed auth and
///                   reached the upstream); the upstream itself errored — e.g.
///                   OpenRouter's "model not available in your region", which is
///                   unrelated to auth.
///
/// Point it at your deployed **Worker** and **container** URLs and flip the
/// target to prove both runtimes enforce auth identically. App Attest and
/// DeviceCheck only work on a **real device** (they report "unsupported" on the
/// simulator).
struct ContentView: View {
  @AppStorage("omni.workerURL") private var workerURL = "https://your-worker.workers.dev"
  @AppStorage("omni.containerURL") private var containerURL = "https://your-container.example.com"
  @AppStorage("omni.model") private var model = "openai/gpt-4o-mini"
  @State private var target: Target = .worker
  @State private var states: [AuthMethod: RunState] = [:]
  @State private var running = false

  private enum Target: String, CaseIterable, Identifiable {
    case worker = "Worker"
    case container = "Container"
    var id: String { rawValue }
  }

  private var activeURL: String { target == .worker ? workerURL : containerURL }

  var body: some View {
    NavigationStack {
      Form {
        Section("Proxy") {
          Picker("Target", selection: $target) {
            ForEach(Target.allCases) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.segmented)

          LabeledURLField(title: "Worker URL", text: $workerURL)
          LabeledURLField(title: "Container URL", text: $containerURL)
          HStack {
            Text("Model").foregroundStyle(.secondary)
            TextField("model", text: $model).multilineTextAlignment(.trailing)
              .autocorrectionDisabled().textInputAutocapitalization(.never)
          }
        }

        Section("Methods") {
          ForEach(AuthMethod.allCases) { method in
            MethodRow(
              method: method,
              state: states[method] ?? .idle,
              action: { Task { await run(method) } }
            )
          }
        }

        Section {
          Button {
            Task { await runAll() }
          } label: {
            Label(running ? "Running…" : "Run all against \(target.rawValue)", systemImage: "checklist")
              .frame(maxWidth: .infinity)
          }
          .disabled(running)
        } footer: {
          Text(
            "Green = credential accepted and chat completed. Amber = credential accepted, "
              + "upstream errored (e.g. model unavailable in region — not an auth failure). "
              + "Red = the proxy rejected the credential. App Attest & DeviceCheck need a real device."
          )
        }
      }
      .navigationTitle("Auth verification")
    }
  }

  private func run(_ method: AuthMethod) async {
    states[method] = .running
    guard let endpoint = endpoint() else {
      states[method] = .fail("Set a valid \(target.rawValue) URL first")
      return
    }
    do {
      let provider = try await provider(for: method, endpoint: endpoint)
      // The exact headers the MacPaw OmniAuthMiddleware would inject.
      let headers = try await provider.headers()

      var request = URLRequest(url: endpoint.rootURL(path: "/v1/chat/completions"))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      request.httpBody = try JSONSerialization.data(withJSONObject: [
        "model": model,
        "messages": [["role": "user", "content": "Reply with exactly the word: pong"]],
        "max_tokens": 5,
        "temperature": 0,
      ])

      let (data, response) = try await URLSession.shared.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let decoded = decode(data)

      switch status {
      case 200:
        states[method] = .pass(decoded.content?.isEmpty == false ? decoded.content! : "200 OK")
      case 401:
        states[method] = .fail("401 rejected — \(decoded.error ?? "unauthorized")")
      default:
        // Passed auth (not 401) but the upstream errored — the credential is fine.
        states[method] = .authOnly("upstream \(status): \(decoded.error ?? "error")")
      }
    } catch {
      states[method] = .fail(describe(error))
    }
  }

  private func runAll() async {
    running = true
    defer { running = false }
    for method in AuthMethod.allCases { await run(method) }
  }

  private func endpoint() -> OmniEndpoint? {
    let trimmed = activeURL.trimmingCharacters(in: .whitespaces)
    guard let url = URL(string: trimmed), url.host != nil, url.scheme != nil else { return nil }
    return OmniEndpoint(trimmed)
  }

  private func provider(for method: AuthMethod, endpoint: OmniEndpoint) async throws -> OmniAuthProvider {
    switch method {
    case .firebaseAuth:
      #if canImport(FirebaseAuth)
        if Auth.auth().currentUser == nil {
          _ = try await Auth.auth().signInAnonymously()
        }
        return FirebaseIDTokenAuth(forcingRefresh: true)
      #else
        throw VerificationError.unavailable("FirebaseAuth not linked")
      #endif
    case .appCheck:
      #if canImport(FirebaseAppCheck)
        return FirebaseAppCheckAuth(forcingRefresh: true)
      #else
        throw VerificationError.unavailable("FirebaseAppCheck not linked")
      #endif
    case .deviceCheck:
      #if canImport(DeviceCheck)
        return DeviceCheckAuth()
      #else
        throw VerificationError.unavailable("DeviceCheck not available")
      #endif
    case .appAttest:
      #if canImport(DeviceCheck)
        return AppAttestAuth(endpoint: endpoint)
      #else
        throw VerificationError.unavailable("App Attest not available")
      #endif
    }
  }

  /// Pull the assistant text or the error message out of a chat-completions body.
  private func decode(_ data: Data) -> (content: String?, error: String?) {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return (nil, nil)
    }
    if let error = obj["error"] as? [String: Any], let message = error["message"] as? String {
      return (nil, message)
    }
    if let choices = obj["choices"] as? [[String: Any]],
      let message = choices.first?["message"] as? [String: Any],
      let content = message["content"] as? String
    {
      return (content.trimmingCharacters(in: .whitespacesAndNewlines), nil)
    }
    return (nil, nil)
  }

  private func describe(_ error: Error) -> String {
    switch error {
    case OmniAuthError.deviceCheckUnsupported:
      return "DeviceCheck unsupported (needs a real device)"
    case OmniAuthError.appAttestUnsupported:
      return "App Attest unsupported (needs a real device)"
    case OmniAuthError.notSignedIn:
      return "Not signed in"
    case let OmniAuthError.httpError(status, body):
      return "handshake HTTP \(status): \(body.prefix(120))"
    default:
      return String(describing: error).prefix(200).description
    }
  }
}

private enum VerificationError: LocalizedError {
  case unavailable(String)
  var errorDescription: String? {
    switch self { case let .unavailable(message): return message }
  }
}

/// The four credential types, each mapped to its proxy verifier + header.
private enum AuthMethod: String, CaseIterable, Identifiable {
  case firebaseAuth = "Firebase Auth"
  case appCheck = "Firebase App Check"
  case deviceCheck = "DeviceCheck"
  case appAttest = "App Attest"

  var id: String { rawValue }

  var subtitle: String {
    switch self {
    case .firebaseAuth: return "firebase-auth · Authorization: Bearer"
    case .appCheck: return "firebase-app-check · X-Firebase-AppCheck"
    case .deviceCheck: return "apple-device-check · X-Apple-Device-Token · device only"
    case .appAttest: return "apple-app-attest · x-appattest-* · device only"
    }
  }
}

private enum RunState {
  case idle
  case running
  case pass(String)
  case authOnly(String)
  case fail(String)
}

private struct MethodRow: View {
  let method: AuthMethod
  let state: RunState
  let action: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        icon
        VStack(alignment: .leading, spacing: 2) {
          Text(method.rawValue).font(.body)
          Text(method.subtitle).font(.caption2).foregroundStyle(.secondary)
        }
        Spacer()
        Button("Run", action: action).buttonStyle(.bordered).disabled(isRunning)
      }
      if let detail {
        Text(detail).font(.caption).foregroundStyle(detailColor)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.vertical, 2)
  }

  @ViewBuilder private var icon: some View {
    switch state {
    case .idle: Image(systemName: "circle").foregroundStyle(.secondary)
    case .running: ProgressView()
    case .pass: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
    case .authOnly: Image(systemName: "checkmark.seal.fill").foregroundStyle(.orange)
    case .fail: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
    }
  }

  private var isRunning: Bool { if case .running = state { return true }; return false }

  private var detailColor: Color {
    switch state {
    case .fail: return .red
    case .authOnly: return .orange
    default: return .secondary
    }
  }

  private var detail: String? {
    switch state {
    case .idle, .running: return nil
    case let .pass(text): return "PASS — \(text)"
    case let .authOnly(text): return "AUTH OK — \(text)"
    case let .fail(text): return "FAIL — \(text)"
    }
  }
}

private struct LabeledURLField: View {
  let title: String
  @Binding var text: String

  var body: some View {
    HStack {
      Text(title).foregroundStyle(.secondary)
      TextField("https://…", text: $text)
        .multilineTextAlignment(.trailing)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
    }
  }
}

#Preview {
  ContentView()
}
