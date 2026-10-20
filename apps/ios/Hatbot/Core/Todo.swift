// The to-do list (PLAN.md §19): todo.md in memory, which Hatbot keeps and reminds you of.
import Foundation

/// An item on the list, with the task working on it if one is.
struct TodoItem: Codable, Identifiable, Equatable, Sendable {
  /// Its line in the file, from 0.
  var line: Int
  var done: Bool
  var text: String
  /// YYYY-MM-DD, in the brain's local time.
  var due: String?
  /// HH:MM, for an item due at a time.
  var at: String?
  var doneOn: String?
  var taskId: Int?

  var id: String { "\(line) \(text)" }
}

/// Open items, and those ticked off in the last week.
struct TodoList: Codable, Equatable, Sendable {
  var items: [TodoItem]
}

/// Each loads into `todos`, and keeps it.
extension AppStore {
  func loadTodos() async throws {
    keep(try await api.get("/todo"))
  }

  /// `due` is YYYY-MM-DD.
  func addTodo(_ item: String, due: String?) async throws {
    struct Body: Encodable { let item: String; let due: String? }
    keep(try await api.post("/todo", body: Body(item: item, due: due)))
  }

  func tickTodo(_ t: TodoItem) async throws {
    keep(try await api.post("/todo/done", body: PickTodo(text: t.text, line: t.line)))
  }

  /// A task on the item, in Hatbot's chat; the item is ticked off when it ends done.
  func workOnTodo(_ t: TodoItem) async throws -> AgentTask {
    let task: AgentTask = try await api.post("/todo/work", body: PickTodo(text: t.text, line: t.line))
    tasks[task.id] = task
    return task
  }

  /// The tasks working on to-do items now: the list is read again when one starts or ends.
  var todoTasks: [Int] {
    tasks.values.filter { $0.todo != nil && $0.isActive }.map(\.id).sorted()
  }
}

private struct PickTodo: Encodable {
  let text: String
  let line: Int
}
