// Photos and files on their way up: the composer's and the share extension's.
import UIKit
import UniformTypeIdentifiers

/// What a picked photo or file becomes before it's uploaded.
enum PickedFile {
  /// Photos go up as JPEG, at most 2048 pixels on the long side: the model reads those directly.
  static func photo(_ data: Data, index: Int) -> (data: Data, name: String, preview: UIImage?)? {
    guard let image = UIImage(data: data) else { return nil }
    let longest = max(image.size.width, image.size.height)
    let scale = min(1, 2048 / max(longest, 1))
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
    guard let jpeg = resized.jpegData(compressionQuality: 0.85) else { return nil }
    return (jpeg, "photo-\(index).jpg", resized)
  }

  /// A file from Files, read inside its security scope.
  static func file(_ url: URL) -> (data: Data, name: String, mediaType: String)? {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else { return nil }
    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    return (data, url.lastPathComponent, type)
  }
}
