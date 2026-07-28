import XCTest

@testable import OmniModelFoundation

final class AuthTests: XCTestCase {
  func testPublishableKeyUsesOpenAIBearerHeader() async throws {
    let auth = PublishableKeyAuth(staticKey: "omk_test")
    let headers = try await auth.headers()
    XCTAssertEqual(headers, ["Authorization": "Bearer omk_test"])
  }

  func testUserTokenUsesDedicatedRawHeader() async throws {
    let auth = UserTokenAuth(staticToken: "signed-user-token")
    let headers = try await auth.headers()
    XCTAssertEqual(headers, ["X-Omni-User-Token": "signed-user-token"])
  }

  func testCombinedAuthKeepsPublishableAndUserCredentialsSeparate() async throws {
    let auth = CombinedAuth([
      PublishableKeyAuth(staticKey: "omk_test"),
      UserTokenAuth(header: "X-Firebase-ID-Token", staticToken: "firebase-token"),
    ])
    let headers = try await auth.headers()
    XCTAssertEqual(headers["Authorization"], "Bearer omk_test")
    XCTAssertEqual(headers["X-Firebase-ID-Token"], "firebase-token")
  }
}
