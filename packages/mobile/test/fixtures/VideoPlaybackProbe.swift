import Foundation
import AVFoundation
import CoreVideo

@main
struct VideoPlaybackProbe {
    static func main() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { try? FileManager.default.removeItem(at: file) }
        let writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
        ])
        writer.add(input)
        precondition(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<90 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var pixel: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32ARGB, nil, &pixel)
            let buffer = pixel!
            CVPixelBufferLockBaseAddress(buffer, [])
            memset(CVPixelBufferGetBaseAddress(buffer), Int32(frame % 255), CVPixelBufferGetDataSize(buffer))
            CVPixelBufferUnlockBaseAddress(buffer, [])
            precondition(adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)))
        }
        input.markAsFinished()
        await writer.finishWriting()
        precondition(writer.status == .completed)
        let bytes = try Data(contentsOf: file)
        var server: YuriVideoServer!
        server = YuriVideoServer(assetId: "avfoundation-test") { event in
            guard event["cancelled"] as? Bool != true, let id = event["requestId"] as? String else { return }
            let range = (event["range"] as? String ?? "bytes=0-").dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            let start = Int(range[0]) ?? 0
            let end = min(Int(range.last!) ?? (bytes.count - 1), start + YuriVideoServer.maxRangeBytes - 1, bytes.count - 1)
            if start >= bytes.count {
                server.respond(requestId: id, status: 416, contentType: nil, contentRange: "bytes */\(bytes.count)", contentLength: 0, data: Data())
            } else {
                let head = event["method"] as? String == "HEAD"
                server.respond(requestId: id, status: head ? 200 : 206, contentType: "video/mp4",
                               contentRange: head ? nil : "bytes \(start)-\(end)/\(bytes.count)",
                               contentLength: head ? bytes.count : end - start + 1,
                               data: head ? Data() : bytes.subdata(in: start..<(end + 1)))
            }
        }
        let url: String = try await withCheckedThrowingContinuation { continuation in server.start { continuation.resume(with: $0) } }
        defer { server.stop() }
        let asset = AVURLAsset(url: URL(string: url)!)
        let playable = try await asset.load(.isPlayable)
        precondition(playable)
        let generator = AVAssetImageGenerator(asset: asset)
        for seconds in [0.2, 2.5, 1.0] {
            let image = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
            precondition(image.image.width == 64 && image.image.height == 64)
        }
        print("AVFoundation first frame and forward/backward seek passed")
    }
}
