import OpenAI
import SwiftUI

#if canImport(FirebaseAuth)
  import FirebaseAuth
#endif

/// On-device verification of every auth method omni-model supports, against a
/// running proxy. Each row refreshes an `OmniAuthBox` from one `OmniAuthProvider`
/// (Firebase Auth / App Check / DeviceCheck / App Attest), sends a real chat
/// through the MacPaw/OpenAI client, and reports PASS (the proxy accepted the
/// credential and completed the request) or FAIL (with the reason).
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
            "Sends one tiny chat per method to \(activeURL). App Attest & DeviceCheck "
              + "require a real device. Firebase Auth signs in anonymously."
          )
        }
      }
      .navigationTitle("Auth verification")
    }
  }

  private func run(_ method: AuthMethod) async {
    states[method] = .running
    do {
      guard let endpoint = endpoint() else {
        states[method] = .fail("Set a valid \(target.rawValue) URL first")
        return
      }
      let provider = try await provider(for: method, endpoint: endpoint)
      let box = OmniAuthBox()
      try await box.refresh(from: provider)
      let client = OmniModel.makeOpenAI(endpoint: endpoint, box: box)
      let result = try await client.chats(
        query: ChatQuery(
          messages: [.user(.init(content: .string("Reply with exactly the word: pong")))],
          model: model
        )
      )
      let content = result.choices.first?.message.content ?? ""
      states[method] = .pass(content.isEmpty ? "200 OK" : content.trimmingCharacters(in: .whitespacesAndNewlines))
    } catch {
      states[method] = .fail(describe(error))
    }
  }

  private func runAll() async {
    running = true
    defer { running = false }
    for method in AuthMethod.allCases {
      await run(method)
    }
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

  private func describe(_ error: Error) -> String {
    switch error {
    case OmniAuthError.deviceCheckUnsupported:
      return "DeviceCheck unsupported (needs a real device)"
    case OmniAuthError.appAttestUnsupported:
      return "App Attest unsupported (needs a real device)"
    case OmniAuthError.notSignedIn:
      return "Not signed in"
    case let OmniAuthError.httpError(status, body):
      return "HTTP \(status): \(body.prefix(140))"
    default:
      return String(describing: error).prefix(200).description
    }
  }
}

private enum VerificationError: LocalizedError {
  case unavailable(String)
  var errorDescription: String? {
    switch self { case let .unavailable(m): return m }
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
        Text(detail).font(.caption).foregroundStyle(isFail ? .red : .secondary)
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
    case .fail: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
    }
  }

  private var isRunning: Bool { if case .running = state { return true }; return false }
  private var isFail: Bool { if case .fail = state { return true }; return false }
  private var detail: String? {
    switch state {
    case .idle, .running: return nil
    case let .pass(text): return "PASS — \(text)"
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
