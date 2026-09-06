import Foundation

/// Host HTTP client — URLSession shapes for Lynx inject.
/// Mirrors `packages/lynx/src/host/httpClient.ts`.
/// Wire URLSession (optional TLS pinning / cookie jar) before first Lynx paint.
struct OpenChamberLynxHttpRequest {
  var url: URL
  var method: String
  var headers: [String: String]
  var body: Data?
  var timeoutMs: Int
}

struct OpenChamberLynxHttpResponse {
  var ok: Bool
  var status: Int
  var headers: [String: String]
  var bodyText: String?
}

protocol OpenChamberLynxHttpClienting: AnyObject {
  func request(_ input: OpenChamberLynxHttpRequest) async -> OpenChamberLynxHttpResponse?
}

/// Stub: builds a real URLRequest shape; returns nil until URLSession is injected.
final class OpenChamberLynxHttpClient: OpenChamberLynxHttpClienting {
  var session: URLSession = .shared

  func request(_ input: OpenChamberLynxHttpRequest) async -> OpenChamberLynxHttpResponse? {
    var urlRequest = URLRequest(url: input.url, timeoutInterval: TimeInterval(max(1, input.timeoutMs)) / 1000)
    urlRequest.httpMethod = input.method
    for (key, value) in input.headers {
      urlRequest.setValue(value, forHTTPHeaderField: key)
    }
    urlRequest.httpBody = input.body
    // Inject point: replace with pinned session / relay tunnel.
    // Linux/Xcode-less agents never claim a live call from this stub alone.
    do {
      let (data, response) = try await session.data(for: urlRequest)
      guard let http = response as? HTTPURLResponse else { return nil }
      return OpenChamberLynxHttpResponse(
        ok: (200...299).contains(http.statusCode),
        status: http.statusCode,
        headers: http.allHeaderFields.reduce(into: [:]) { acc, pair in
          if let key = pair.key as? String, let value = pair.value as? String {
            acc[key] = value
          }
        },
        bodyText: String(data: data, encoding: .utf8)
      )
    } catch {
      return nil
    }
  }
}
