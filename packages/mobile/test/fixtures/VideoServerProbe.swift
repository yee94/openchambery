import Foundation

@main
struct VideoServerProbe {
    static func main() {
        let output = NSLock()
        func emit(_ value: [String: Any]) {
            output.lock(); defer { output.unlock() }
            let bytes = try! JSONSerialization.data(withJSONObject: value)
            FileHandle.standardOutput.write(bytes + Data([10]))
        }
        let server = OpenChamberVideoServer(assetId: "test-video-opaque", emit: emit)
        server.start { result in
            switch result {
            case .success(let url): emit(["url": url])
            case .failure: emit(["error": "start failed"]); exit(1)
            }
        }
        DispatchQueue.global().async {
            while let line = readLine(), let data = line.data(using: .utf8),
                  let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if command["stop"] as? Bool == true { server.stop(); exit(0) }
                server.respond(requestId: command["requestId"] as! String,
                               status: command["status"] as! Int,
                               contentType: command["contentType"] as? String,
                               contentRange: command["contentRange"] as? String,
                               contentLength: command["contentLength"] as? Int,
                               data: Data(base64Encoded: command["dataBase64"] as? String ?? "") ?? Data())
            }
            server.stop(); exit(0)
        }
        dispatchMain()
    }
}
