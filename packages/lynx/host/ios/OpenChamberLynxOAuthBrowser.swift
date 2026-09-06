import AuthenticationServices
import Foundation

/// ASWebAuthenticationSession launcher stub.
/// Mirrors `packages/lynx/src/host/oauthBrowser.ts`.
/// Inject point: present from the host window's presentationAnchor.
enum OpenChamberLynxOAuthBrowserResult {
  case ok(callbackUrl: URL?)
  case cancelled
  case unavailable
  case failed(String)
}

protocol OpenChamberLynxOAuthBrowsing: AnyObject {
  func openAuthorize(
    url: URL,
    callbackScheme: String,
    prefersEphemeral: Bool
  ) async -> OpenChamberLynxOAuthBrowserResult
}

/// Stub session factory. Real device binary must set presentationContextProvider.
final class OpenChamberLynxOAuthBrowser: NSObject, OpenChamberLynxOAuthBrowsing, ASWebAuthenticationPresentationContextProviding {
  weak var presentationAnchor: ASPresentationAnchor?

  func openAuthorize(
    url: URL,
    callbackScheme: String,
    prefersEphemeral: Bool
  ) async -> OpenChamberLynxOAuthBrowserResult {
    // Without a presentation anchor (Linux/scaffold) stay unavailable — never fake OAuth.
    guard presentationAnchor != nil else { return .unavailable }
    return await withCheckedContinuation { continuation in
      let session = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: callbackScheme
      ) { callbackURL, error in
        if let error = error as? ASWebAuthenticationSessionError,
           error.code == .canceledLogin {
          continuation.resume(returning: .cancelled)
          return
        }
        if let error {
          continuation.resume(returning: .failed(error.localizedDescription))
          return
        }
        continuation.resume(returning: .ok(callbackUrl: callbackURL))
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = prefersEphemeral
      if !session.start() {
        continuation.resume(returning: .failed("ASWebAuthenticationSession failed to start"))
      }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    presentationAnchor ?? ASPresentationAnchor()
  }
}
