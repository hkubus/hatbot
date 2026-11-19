import SwiftMath
import SwiftUI
import UIKit

/// LaTeX drawn by SwiftMath, in black for SwiftUI to tint as text, kept by its source and size: the chat
/// draws the same maths again as you scroll.
@MainActor
enum TeX {
  struct Drawn: @unchecked Sendable {
    let image: UIImage
    /// How far it reaches below its baseline.
    let descent: CGFloat
  }

  nonisolated(unsafe) private static let cache: NSCache<NSString, CacheBox<Drawn?>> = {
    let c = NSCache<NSString, CacheBox<Drawn?>>()
    c.countLimit = 500
    return c
  }()

  /// Nil if SwiftMath can't read it.
  static func draw(_ tex: String, size: CGFloat, display: Bool) -> Drawn? {
    let key = NSString(string: "\(display ? "d" : "t")\(size)\u{0}\(tex)")
    if let hit = cache.object(forKey: key) { return hit.value }
    var math = MathImage(
      latex: tex, fontSize: size, textColor: .black, labelMode: display ? .display : .text, textAlignment: .left)
    let (error, image, layout) = math.asImage()
    let drawn = error == nil ? image.flatMap { i in layout.map { Drawn(image: i, descent: $0.descent) } } : nil
    cache.setObject(CacheBox(drawn), forKey: key)
    return drawn
  }

  /// KaTeX's size beside the text on the web.
  static func size(_ scale: CGFloat) -> CGFloat { Typeface.size(.body) * scale * 1.2 }
}

/// Maths on lines of its own: centred while it fits, scrolled sideways when it doesn't.
struct MathBlock: View {
  let tex: String
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  var body: some View {
    if let drawn = TeX.draw(tex, size: TeX.size(scale), display: true) {
      let image = Image(uiImage: drawn.image).renderingMode(.template).accessibilityLabel(Text(verbatim: tex))
      ViewThatFits(in: .horizontal) {
        image.frame(maxWidth: .infinity)
        ScrollView(.horizontal) { image }.scrollBounceBehavior(.basedOnSize, axes: .horizontal)
      }
    } else {
      Text(verbatim: tex).font(.code(.footnote))
    }
  }
}
