import OpenAI
import SwiftUI

/// A tiny chat screen that streams a completion from your omni-model proxy
/// using the real MacPaw/OpenAI client + the `OmniAuthMiddleware` in
/// `OmniModelClient.swift`.
struct ContentView: View {
  @State private var prompt = "Say hello in one short sentence."
  @State private var output = ""
  @State private var errorText: String?
  @State private var isStreaming = false

  // Edit `OmniEndpoint.production` in OmniModelClient.swift, or override here.
  private let box = OmniAuthBox()

  /// Pick the provider that matches your proxy's `security.providers`.
  /// FirebaseAppCheck is the default here; swap for FirebaseIDTokenAuth,
  /// BearerTokenAuth { ... }, AppAttestAuth(), or DeviceCheckAuth().
  private let auth: OmniAuthProvider = FirebaseAppCheckAuth()

  var body: some View {
    NavigationStack {
      VStack(spacing: 12) {
        TextField("Prompt", text: $prompt, axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .lineLimit(1...4)

        Button(action: { Task { await send() } }) {
          Label(isStreaming ? "Streaming…" : "Send", systemImage: "paperplane.fill")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(isStreaming || prompt.isEmpty)

        if let errorText {
          Text(errorText).foregroundStyle(.red).font(.footnote)
        }

        ScrollView {
          Text(output.isEmpty ? "Response will stream here." : output)
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(output.isEmpty ? .secondary : .primary)
        }
      }
      .padding()
      .navigationTitle("omni-model")
    }
  }

  private func send() async {
    isStreaming = true
    errorText = nil
    output = ""
    defer { isStreaming = false }

    do {
      // Refresh auth into the box, then let the middleware stamp it onto the
      // streaming request. `model` is whatever your routing expects.
      try await box.refresh(from: auth)
      let openAI = OmniModel.makeOpenAI(box: box)
      let query = ChatQuery(
        messages: [.user(.init(content: .string(prompt)))],
        model: "gpt-4o-mini"
      )
      for try await chunk in openAI.chatsStream(query: query) {
        for choice in chunk.choices {
          if let piece = choice.delta.content { output += piece }
        }
      }
    } catch {
      errorText = "\(error)"
    }
  }
}

#Preview {
  ContentView()
}
