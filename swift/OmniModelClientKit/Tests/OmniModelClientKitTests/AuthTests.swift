import XCTest

@testable import OmniModelClientKit

final class AuthTests: XCTestCase {
  func testCombinedAuthSeparatesPublishableAndUserCredentials() async throws {
    let auth = CombinedAuth([
      PublishableKeyAuth(staticKey: "omk_test"),
      UserTokenAuth(header: "X-Firebase-ID-Token", staticToken: "firebase-token"),
    ])

    let headers = try await auth.headers()

    XCTAssertEqual(headers["Authorization"], "Bearer omk_test")
    XCTAssertEqual(headers["X-Firebase-ID-Token"], "firebase-token")
  }
}
