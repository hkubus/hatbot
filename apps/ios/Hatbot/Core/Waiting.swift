// What waits on you (apps/web/src/waiting.ts).
import Foundation

enum Waiting {
  /// The app's badge and the widget's count: approvals to answer, not what the review blocked or a
  /// message on its way; questions; and screens asking you to take over.
  static func count(
    approvals: some Sequence<Approval>, questions: some Sequence<Question>, desktop: DesktopState?,
    computers: [ComputerInfo]
  ) -> Int {
    approvals.filter { $0.status == .pending }.count + questions.filter { $0.status == .pending }.count
      + (desktop?.request == nil ? 0 : 1) + computers.filter { $0.request != nil }.count
  }
}
