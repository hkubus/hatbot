import Foundation
#if canImport(CoreGraphics)
  import CoreGraphics
#endif

/// A point on the unzoomed screen shows at `point * scale + offset`.
struct Zoom: Equatable {
  var scale: CGFloat = 1
  var offset: CGPoint = .zero

  static let most: CGFloat = 5

  /// `center` and `pan` are in view points.
  func zoomed(by factor: CGFloat, at center: CGPoint, pan: CGPoint = .zero, in size: CGSize) -> Zoom {
    let k = min(max(scale * factor, 1), Self.most)
    let f = k / scale
    // The point under `center` stays under it.
    let o = CGPoint(x: center.x - (center.x - offset.x) * f + pan.x, y: center.y - (center.y - offset.y) * f + pan.y)
    return Zoom(scale: k, offset: o).kept(in: size)
  }

  func moved(by pan: CGPoint, in size: CGSize) -> Zoom {
    Zoom(scale: scale, offset: CGPoint(x: offset.x + pan.x, y: offset.y + pan.y)).kept(in: size)
  }

  func unzoomed(_ p: CGPoint) -> CGPoint {
    CGPoint(x: (p.x - offset.x) / scale, y: (p.y - offset.y) / scale)
  }

  private func kept(in size: CGSize) -> Zoom {
    let x = min(0, max(size.width - size.width * scale, offset.x))
    let y = min(0, max(size.height - size.height * scale, offset.y))
    return Zoom(scale: scale, offset: CGPoint(x: x, y: y))
  }
}
