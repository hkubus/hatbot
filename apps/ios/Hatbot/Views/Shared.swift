// Colors, navigation routes and small views the screens share.
import SwiftUI
import UIKit

extension Color {
  /// Hatbot's amber (PLAN.md §10.2). Blue means "needs you", red destructive, green done.
  static let brand = Color(light: 0xE8820C, dark: 0xFF9F2E)
  static let attention = Color.blue
  /// Solid, with white text, like Messages' blue; Hatbot's grey is Messages' too.
  static let userBubble = Color(uiColor: UIColor(hex: 0xE8820C, alpha: 1))
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
      }
    }
  }
}

func message(for error: Error) -> String {
  (error as? APIError)?.message ?? "Couldn't reach Hatbot."
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
    case .running: .brand
    case .done: .green
    case .failed: .red
    case .queued, .cancelled: .secondary
    }
  }
}

/// Screenshots need the bearer token, so they don't go through AsyncImage.
@MainActor
final class ScreenCache {
  static let shared = ScreenCache()
  private let cache = NSCache<NSString, UIImage>()

  func image(_ api: API, taskId: Int, stepId: Int) async throws -> UIImage {
    let key = "\(api.server.absoluteString)/\(taskId)/\(stepId)" as NSString
    if let hit = cache.object(forKey: key) { return hit }
    let data = try await api.data("/tasks/\(taskId)/screens/\(stepId)")
    guard let image = await Task.detached(operation: { UIImage(data: data)?.preparingForDisplay() }).value else {
      throw APIError(status: 0, message: "Not an image")
    }
    cache.setObject(image, forKey: key)
    return image
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
      if let image { ImageViewer(image: image) }
    }
    .task(id: stepId) {
      do {
        image = try await ScreenCache.shared.image(store.api, taskId: taskId, stepId: stepId)
      } catch {
        failed = true
      }
    }
    .accessibilityLabel("Screenshot")
  }
}

/// A screenshot full screen: pinch to zoom, drag to pan, double tap to toggle.
struct ImageViewer: View {
  let image: UIImage
  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @GestureState private var pinch: CGFloat = 1
  @GestureState private var drag: CGSize = .zero

  var body: some View {
    NavigationStack {
      Image(uiImage: image)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .scaleEffect(scale * pinch)
        .offset(x: offset.width + drag.width, y: offset.height + drag.height)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .gesture(
          MagnifyGesture()
            .updating($pinch) { value, state, _ in state = value.magnification }
            .onEnded { value in
              scale = min(5, max(1, scale * value.magnification))
              if scale == 1 { offset = .zero }
            }
            .simultaneously(
              with: DragGesture()
                .updating($drag) { value, state, _ in if scale > 1 { state = value.translation } }
                .onEnded { value in
                  guard scale > 1 else { return }
                  offset.width += value.translation.width
                  offset.height += value.translation.height
                })
        )
        .onTapGesture(count: 2) {
          withAnimation(.spring) {
            if scale > 1 {
              scale = 1
              offset = .zero
            } else {
              scale = 2.5
            }
          }
        }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .topBarLeading) {
            ShareLink(item: Image(uiImage: image), preview: SharePreview("Screenshot", image: Image(uiImage: image)))
          }
        }
    }
  }
}
