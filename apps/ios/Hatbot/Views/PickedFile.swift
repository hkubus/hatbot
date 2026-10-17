// Photos and files on their way up: the composer's and the share extension's. Photos are scaled with
// ImageIO straight from the file, never decoded whole, which keeps the share extension under its memory limit.
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// What a picked photo or file becomes before it's uploaded.
enum PickedFile {
  /// A photo as it goes up, with a small preview for the composer.
  struct Photo: @unchecked Sendable {
    var data: Data
    var name: String
    var preview: UIImage?
  }

  /// Photos go up as JPEG, at most 2048 pixels on the long side: the model reads those directly.
  static let longSide = 2048

  static func photo(_ data: Data, index: Int) -> Photo? {
    CGImageSourceCreateWithData(data as CFData, nil).flatMap { photo($0, index: index) }
  }

  static func photo(at url: URL, index: Int) -> Photo? {
    CGImageSourceCreateWithURL(url as CFURL, nil).flatMap { photo($0, index: index) }
  }

  private static func photo(_ source: CGImageSource, index: Int) -> Photo? {
    guard let image = thumbnail(source, longSide), let jpeg = jpeg(image) else { return nil }
    let preview = thumbnail(source, 240).map { UIImage(cgImage: $0) }
    return Photo(data: jpeg, name: "photo-\(index).jpg", preview: preview)
  }

  /// The image at most `size` pixels on its long side, turned upright; a smaller one stays its size.
  private static func thumbnail(_ source: CGImageSource, _ size: Int) -> CGImage? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: size,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }

  private static func jpeg(_ image: CGImage) -> Data? {
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
    CGImageDestinationAddImage(dest, image, options as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return out as Data
  }

  /// A file from Files, read inside its security scope.
  static func file(_ url: URL) -> (data: Data, name: String, mediaType: String)? {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (data, url.lastPathComponent, mediaType(url))
  }

  /// A file lent for a moment (the share sheet's), copied somewhere it stays until it's uploaded. One over
  /// `limit` bytes isn't copied or read: that throws CocoaError.fileReadTooLarge.
  static func copy(_ url: URL, name: String? = nil, limit: Int? = nil) throws -> URL {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    if let limit, let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > limit {
      throw CocoaError(.fileReadTooLarge)
    }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    let copy = dir.appendingPathComponent((name ?? url.lastPathComponent).replacingOccurrences(of: "/", with: "_"))
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: url, to: copy)
    return copy
  }

  static func mediaType(_ url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }
}
