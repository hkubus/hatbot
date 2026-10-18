// To-do (PLAN.md §19): the list Hatbot keeps and reminds you of, with boxes to tick items off and a
// task to work on one.
import SwiftUI

struct TodoView: View {
  @Environment(AppStore.self) private var store
  @Binding var path: [Route]
  @State private var list: TodoList?
  @State private var error: String?
  @State private var adding = false
  @State private var newItem = ""
  @State private var hasDue = false
  @State private var newDue = Date()

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let error {
          Text(error).foregroundStyle(.red)
        }
        let open = list?.items.filter { !$0.done } ?? []
        let done = Array((list?.items.filter(\.done) ?? []).reversed())
        Section {
          if list != nil && open.isEmpty {
            Text("Nothing to do. Add one here, or ask Hatbot in the chat.").foregroundStyle(.secondary)
          }
          ForEach(open) { t in row(t) }
        }
        if !done.isEmpty {
          Section("Done this week") {
            ForEach(done) { t in
              HStack {
                Image(systemName: "checkmark.square.fill").foregroundStyle(.tint)
                Text(t.text).foregroundStyle(.secondary)
                Spacer()
                if let on = t.doneOn { Text(Self.day(on)).foregroundStyle(.secondary) }
              }
            }
          }
        }
      }
      .overlay { if list == nil && error == nil { ProgressView() } }
      .navigationTitle("To-do")
      .navigationBarTitleDisplayMode(.inline)
      .sidebarButton()
      .toolbar {
        ToolbarItem {
          Button("Add", systemImage: "plus") {
            newItem = ""
            hasDue = false
            adding = true
          }
        }
      }
      .sheet(isPresented: $adding) { addSheet }
      .refreshable { await load() }
      .task(id: store.memoryVersion) { await load() }
      .onChange(of: store.todoTasks) { Task { await load() } }
      .routes()
    }
  }

  private func row(_ t: TodoItem) -> some View {
    HStack(spacing: 12) {
      Button {
        Task { await attempt($error) { list = try await store.tickTodo(t) } }
      } label: {
        Image(systemName: "square").font(.title3)
      }
      .buttonStyle(.borderless)
      .accessibilityLabel("Done: \(t.text)")
      Text(t.text)
      Spacer()
      if let id = t.taskId {
        NavigationLink("Working on it", value: Route.task(id))
          .foregroundStyle(.secondary)
          .fixedSize()
      } else if let due = t.due {
        let overdue = due < Self.today()
        Text(overdue ? "Overdue, \(Self.day(due))" : Self.dueText(due, at: t.at))
          .foregroundStyle(overdue ? .red : .secondary)
          .fixedSize()
      }
    }
    .swipeActions(edge: .trailing) {
      if t.taskId == nil {
        Button("Work on it") { work(t) }.tint(.accentColor)
      }
    }
    .contextMenu {
      if t.taskId == nil {
        Button("Work on it", systemImage: "play") { work(t) }
      }
    }
  }

  /// A task on the item, in Hatbot's chat.
  private func work(_ t: TodoItem) {
    Task {
      await attempt($error) {
        _ = try await store.workOnTodo(t)
        store.toast = "Hatbot is on it"
      }
    }
  }

  private var addSheet: some View {
    NavigationStack {
      Form {
        TextField("What's to do", text: $newItem, axis: .vertical)
        Toggle("Due", isOn: $hasDue)
        if hasDue {
          DatePicker("Date", selection: $newDue, displayedComponents: .date)
        }
      }
      .navigationTitle("New to-do")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { adding = false }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add") {
            let item = newItem.trimmingCharacters(in: .whitespacesAndNewlines)
            let due = hasDue ? Self.ymd.string(from: newDue) : nil
            adding = false
            Task { await attempt($error) { list = try await store.addTodo(item, due: due) } }
          }
          .disabled(newItem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .presentationDetents([.medium])
  }

  private func load() async {
    await attempt($error) { list = try await store.loadTodos() }
  }

  /// YYYY-MM-DD in local time, the time zone due dates are in.
  private static let ymd: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f
  }()

  private static func today() -> String { ymd.string(from: Date()) }

  /// "25 Oct".
  private static func day(_ ymdDate: String) -> String {
    guard let d = ymd.date(from: ymdDate) else { return ymdDate }
    return d.formatted(.dateTime.day().month(.abbreviated))
  }

  private static func dueText(_ due: String, at: String?) -> String {
    let when = due == today() ? "Today" : day(due)
    return at.map { "\(when) \($0)" } ?? when
  }
}
