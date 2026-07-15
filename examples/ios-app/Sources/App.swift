import FirebaseAppCheck
import FirebaseCore
import SwiftUI

@main
struct OmniModelExampleApp: App {
  init() {
    // App Check: App Attest on device (iOS 14+), DeviceCheck as a fallback.
    // Install the factory BEFORE FirebaseApp.configure() so tokens mint from
    // the start. Replace Resources/GoogleService-Info.plist with your own
    // project's (the app id must have App Attest enabled in the Firebase console).
    AppCheck.setAppCheckProviderFactory(ExampleAppCheckProviderFactory())
    FirebaseApp.configure()
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}

/// App Check provider factory used by the example. On a real device this is
/// backed by App Attest; DeviceCheck is the fallback for older hardware.
final class ExampleAppCheckProviderFactory: NSObject, AppCheckProviderFactory {
  func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
    if #available(iOS 14.0, *) {
      return AppAttestProvider(app: app)
    }
    return DeviceCheckProvider(app: app)
  }
}
