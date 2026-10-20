// The chat's pictures as the brain sent them for a bubble, kept on disk so the next launch shows them
// without downloading them again. Signing out deletes them (ImageCache.clear).
import Foundation

struct DiskPictures: Sendable {
  let dir: URL
  /// Past this the oldest go, down to three quarters of it. Bubble copies are about 10 to 60 KB; a brain
  /// from before them sends whole photos.
  var budget = 150 << 20

  static let chat = DiskPictures(
    dir: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Pictures", isDirectory: true))

  /// The file for `key`, which may hold any characters.
  func url(_ key: String) -> URL {
    dir.appendingPathComponent(key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key)
  }

  func read(_ key: String) -> Data? {
    try? Data(contentsOf: url(key))
  }

  func write(_ data: Data, _ key: String) {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? data.write(to: url(key), options: .atomic)
  }

  /// Deletes the oldest files once they're over the budget.
  func trim() {
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
    let sized = files.compactMap { url -> (url: URL, date: Date, size: Int)? in
      guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
      return (url, v.contentModificationDate ?? .distantPast, v.fileSize ?? 0)
    }
    var total = sized.reduce(0) { $0 + $1.size }
    guard total > budget else { return }
    for f in sized.sorted(by: { $0.date < $1.date }) where total > budget * 3 / 4 {
      try? FileManager.default.removeItem(at: f.url)
      total -= f.size
    }
  }

  func clear() {
    try? FileManager.default.removeItem(at: dir)
  }
}
