// Colors, navigation routes and small views the screens share.
import ImageIO
import SwiftUI
import UIKit

extension Color {
  /// Hatbot's amber (PLAN.md §10.2), for fills. Blue means "needs you", red destructive, green done.
  /// Amber as text, and the app's tint, is the AccentColor asset (`accentColor`): the brand's amber gives
  /// only 2.75:1 on white, and that one reads at 4.5:1 or better on white, grey bubbles and the sidebar's
  /// selected row.
  static let brand = Color(light: 0xE8820C, dark: 0xFF9F2E)
  static let attention = Color.blue
  /// Solid, with white text, like Messages' blue; Hatbot's grey is Messages' too. A darker amber than
  /// the brand's, so the white reads at 4.9:1 (the brand's own gives 2.75:1).
  static let userBubble = Color(uiColor: UIColor(hex: 0xB05A00, alpha: 1))
  /// Text and glyphs on the brand's amber: 6.1:1, and 8.2:1 on the dark mode amber.
  static let onBrand = Color(uiColor: UIColor(hex: 0x1D1D1F, alpha: 1))
  static let botBubble = Color(light: 0xE9E9EB, dark: 0x262628)

  init(light: UInt32, dark: UInt32, darkOpacity: CGFloat = 1) {
    self.init(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: darkOpacity) : UIColor(hex: light, alpha: 1)
      })
  }
}

extension Bot.Tint {
  var color: Color {
    switch self {
    case .amber: .brand
    case .red: .red
    case .pink: .pink
    case .purple: .purple
    case .indigo: .indigo
    case .blue: .blue
    case .teal: .teal
    case .green: .green
    case .gray: .gray
    }
  }
}

extension UIColor {
  convenience init(hex: UInt32, alpha: CGFloat) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }
}

/// Pages pushed on a tab's navigation stack.
enum Route: Hashable {
  case task(Int)
  case live(taskId: Int?)
  case memoryFile(String, isNew: Bool = false)
  case memoryHistory(path: String?)
  case commit(MemoryCommit)
  case schedules
  case schedule(Int)
  case newSchedule
  case trigger(Int)
  case bot(String)
  case group(Int)
  case watchers
  case watcher(Int)
  case checks
  case heartbeat
  case proposal(Proposal)
  case spend
  case limits
  case devices
}

extension View {
  func routes() -> some View {
    navigationDestination(for: Route.self) { route in
      switch route {
      case let .task(id): TaskDetailView(taskId: id)
      case let .live(taskId): LiveView(taskId: taskId).navigationTitle("Live")
      case let .memoryFile(path, isNew): MemoryFileView(path: path, isNew: isNew)
      case let .memoryHistory(path): MemoryHistoryView(path: path)
      case let .commit(c): CommitView(commit: c)
      case .schedules: SchedulesView()
      case let .schedule(id): ScheduleDetailView(id: id)
      case .newSchedule: ScheduleDetailView(id: nil)
      case let .trigger(id): TriggerDetailView(id: id)
      case let .bot(id): BotView(id: id)
      case let .group(id): GroupView(id: id)
      case .watchers: WatchersView()
      case let .watcher(id): WatcherDetailView(id: id)
      case .checks: ChecksView()
      case .heartbeat: HeartbeatView()
      case let .proposal(p): ProposalView(proposal: p)
      case .spend: SpendView()
      case .limits: LimitsView()
      case .devices: DevicesView()
      }
    }
  }
}

func message(for error: Error) -> String {
  (error as? APIError)?.message ?? "Couldn't reach Hatbot."
}

/// Does `work`, then shows in `error` what went wrong, or clears it if nothing did. An earlier error
/// stays up while it works, rather than going and coming back. A page given `missing` sets it instead
/// when what it shows isn't there.
@MainActor
func attempt(_ error: Binding<String?>, missing: Binding<Bool>? = nil, _ work: () async throws -> Void) async {
  do {
    try await work()
    error.wrappedValue = nil
  } catch let e as APIError where e.status == 404 && missing != nil {
    missing?.wrappedValue = true
  } catch let e {
    error.wrappedValue = message(for: e)
  }
}

extension Binding where Value: Equatable {
  /// A switch or picker that saves as soon as it's changed. `shown` holds the change while it saves;
  /// then `value` shows again, saved or put back, unless it's been changed again meanwhile.
  @MainActor
  static func saving(_ value: Value, shown: Binding<Value?>, save: @escaping (Value) async -> Void) -> Binding<Value> {
    Binding(
      get: { shown.wrappedValue ?? value },
      set: { new in
        shown.wrappedValue = new
        Task {
          await save(new)
          if shown.wrappedValue == new { shown.wrappedValue = nil }
        }
      })
  }
}

extension View {
  /// Asks before deleting what the page shows; once it's deleted, the page closes.
  func confirmingDelete(
    _ title: String, isPresented: Binding<Bool>, error: Binding<String?>,
    delete: @escaping @MainActor () async throws -> Void
  ) -> some View {
    modifier(ConfirmDelete(title: title, isPresented: isPresented, error: error, delete: delete))
  }
}

private struct ConfirmDelete: ViewModifier {
  let title: String
  @Binding var isPresented: Bool
  @Binding var error: String?
  let delete: @MainActor () async throws -> Void
  @Environment(\.dismiss) private var dismiss

  func body(content: Content) -> some View {
    content.confirmationDialog(title, isPresented: $isPresented, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task {
          await attempt($error) {
            try await delete()
            dismiss()
          }
        }
      }
    }
  }
}

extension String {
  /// "14:05", in the phone's own time format.
  var timeText: String {
    Format.date(self)?.formatted(date: .omitted, time: .shortened) ?? ""
  }

  /// The time today, otherwise the date and time.
  var stampText: String {
    guard let date = Format.date(self) else { return "" }
    if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
    return date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
  }
}

/// Three dots that pulse while Hatbot works.
struct TypingDots: View {
  var body: some View {
    Image(systemName: "ellipsis")
      .font(.title3.weight(.bold))
      .foregroundStyle(.secondary)
      .symbolEffect(.variableColor.iterative, options: .repeating)
      .accessibilityLabel("Working")
  }
}

extension TaskStatus {
  var tint: Color {
    switch self {
    case .waitingApproval, .waitingTakeover: .attention
    case .running: .accentColor
    case .done: .green
    case .failed: .red
    case .queued, .cancelled: .secondary
    }
  }
}

/// Pictures decoded at the size they're shown at, not whole: a phone photo decoded whole is 48 MB.
enum Picture {
  /// At most `longSide` pixels on its long side, turned upright; a smaller one stays its size.
  static func decode(_ data: Data, longSide: CGFloat) -> UIImage? {
    let noCache: [CFString: Any] = [kCGImageSourceShouldCache: false]
    guard let source = CGImageSourceCreateWithData(data as CFData, noCache as CFDictionary) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: Int(longSide),
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }

  /// What keeping it costs, in bytes, for a cache's limit.
  static func cost(_ image: UIImage) -> Int {
    image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
  }
}

/// Attachments and screenshots need the bearer token, so they don't go through AsyncImage.
@MainActor
final class ImageCache {
  /// The chat's pictures, at the size the chat shows them (about 2 MB each).
  static let attachments = ImageCache(megabytes: 48)
  /// The desktop's screens, about 6 MB each.
  static let screens = ImageCache(megabytes: 40)
  private let cache = NSCache<NSString, UIImage>()

  init(megabytes: Int) {
    cache.totalCostLimit = megabytes << 20
  }

  /// The picture at `path`, at most `longSide` pixels on its long side. One that isn't kept (opened full
  /// screen, say) is decoded for that and let go when it closes.
  func image(_ api: API, _ path: String, longSide: CGFloat, keep: Bool = true) async throws -> UIImage {
    let key = "\(api.server.absoluteString)\(path)/\(Int(longSide))" as NSString
    if let hit = cache.object(forKey: key) { return hit }
    let data = try await api.data(path)
    guard let image = await Task.detached(operation: { Picture.decode(data, longSide: longSide) }).value else {
      throw APIError(status: 0, message: "Not an image")
    }
    if keep { cache.setObject(image, forKey: key, cost: Picture.cost(image)) }
    return image
  }

  /// Signed out.
  func clear() {
    cache.removeAllObjects()
  }
}

/// A task's screenshot; a tap opens it full screen.
struct Screenshot: View {
  let taskId: Int
  let stepId: Int
  @Environment(AppStore.self) private var store
  @State private var image: UIImage?
  @State private var failed = false
  @State private var full = false

  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
      } else {
        Rectangle().fill(.quaternary)
          .aspectRatio(1280 / 800, contentMode: .fit)
          .overlay { if failed { Image(systemName: "photo").foregroundStyle(.secondary) } else { ProgressView() } }
      }
    }
    .clipShape(.rect(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator, lineWidth: 0.5))
    .contentShape(.rect)
    .onTapGesture { if image != nil { full = true } }
    .fullScreenCover(isPresented: $full) {
      if let image { ImageViewer(image: image, label: "Screenshot") }
    }
    .task(id: stepId) {
      do {
        image = try await ImageCache.screens.image(store.api, "/tasks/\(taskId)/screens/\(stepId)", longSide: 1920)
      } catch {
        failed = true
      }
    }
    .accessibilityLabel("Screenshot")
  }
}

/// A picture full screen: pinch to zoom where your fingers are, drag to move around a zoomed one,
/// double tap to zoom in where you tap or back out, and swipe down to close. It zooms like the live
/// view (Core/Zoom.swift), so it never moves off the screen.
struct ImageViewer: View {
  let image: UIImage
  var label = "Picture"
  @Environment(\.dismiss) private var dismiss
  @State private var zoom = Zoom()
  /// The zoom a pinch or a drag started from.
  @State private var pinchStart: Zoom?
  @State private var dragStart: Zoom?
  /// Pulled down, not zoomed in: let go far enough and it closes.
  @State private var pull: CGFloat = 0

  var body: some View {
    NavigationStack {
      GeometryReader { geo in
        let size = geo.size
        ZStack {
          Image(uiImage: image)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: size.width, height: size.height)
            .scaleEffect(zoom.scale, anchor: .topLeading)
            .offset(x: zoom.offset.x, y: zoom.offset.y + pull)
            .accessibilityLabel(label)
          // The gestures on what doesn't move, so their points are the screen's.
          Color.clear
            .contentShape(.rect)
            .gesture(pinch(size).simultaneously(with: drag(size)))
            .onTapGesture(count: 2, coordinateSpace: .local) { p in
              withAnimation(.snappy) { zoom = zoom.scale > 1 ? Zoom() : zoom.zoomed(by: 2.5, at: p, in: size) }
            }
        }
        .onChange(of: size) { zoom = Zoom() }
      }
      .background(Color.black.opacity(1 - min(0.6, abs(pull) / 500)).ignoresSafeArea())
      .toolbarBackground(.hidden, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .topBarLeading) {
          ShareLink(item: Image(uiImage: image), preview: SharePreview(label, image: Image(uiImage: image)))
        }
      }
    }
    .preferredColorScheme(.dark)
  }

  private func pinch(_ size: CGSize) -> some Gesture {
    MagnifyGesture()
      .onChanged { value in
        let start = pinchStart ?? zoom
        pinchStart = start
        pull = 0
        zoom = start.zoomed(by: value.magnification, at: value.startLocation, in: size)
      }
      .onEnded { _ in pinchStart = nil }
  }

  /// Moves around a zoomed picture; on one that isn't, pulls it down to close.
  private func drag(_ size: CGSize) -> some Gesture {
    DragGesture()
      .onChanged { value in
        guard pinchStart == nil else { return }
        if let start = dragStart ?? (zoom.scale > 1 ? zoom : nil) {
          dragStart = start
          zoom = start.moved(by: CGPoint(x: value.translation.width, y: value.translation.height), in: size)
        } else {
          pull = max(0, value.translation.height)
        }
      }
      .onEnded { value in
        defer { dragStart = nil }
        guard dragStart == nil, pinchStart == nil else { return }
        if pull > 120 || value.predictedEndTranslation.height > 300 {
          dismiss()
        } else {
          withAnimation(.snappy) { pull = 0 }
        }
      }
  }
}
