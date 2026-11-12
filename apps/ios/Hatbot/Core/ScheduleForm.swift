import Foundation

struct ScheduleForm: Equatable {
  var name = ""
  var repeats = true
  var cron = "0 8 * * *"
  var at = Date().addingTimeInterval(3600)
  var prompt = ""
  /// Runs this script instead of a task from `prompt`.
  var scriptId: Int?
  var enabled = true
  /// A script is its bot's own, so another bot doesn't keep it.
  var botId = Bot.hatbot {
    didSet { if botId != oldValue { scriptId = nil } }
  }

  init() {}
  init(_ s: Schedule) {
    name = s.name
    repeats = s.cron != nil
    cron = s.cron ?? "0 8 * * *"
    at = Format.date(s.runAt) ?? Date().addingTimeInterval(3600)
    prompt = s.prompt
    scriptId = s.scriptId
    enabled = s.enabled
    botId = s.botId ?? Bot.hatbot
  }

  /// The same schedule. A repeating one's `at` and a one-off's `cron` are only what the other choice
  /// would start from, and `at` is made from the clock: comparing them kept Save on for good. Nor does
  /// the prompt count while it runs a script.
  static func == (a: Self, b: Self) -> Bool {
    a.name == b.name && a.repeats == b.repeats && a.scriptId == b.scriptId
      && (a.scriptId != nil || a.prompt == b.prompt) && a.enabled == b.enabled
      && a.botId == b.botId && (a.repeats ? a.cron == b.cron : a.at == b.at)
  }

  /// Either the prompt or the script: each takes the other's place.
  var change: AppStore.ScheduleChange {
    AppStore.ScheduleChange(
      name: name.trimmingCharacters(in: .whitespacesAndNewlines),
      prompt: scriptId == nil ? prompt.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
      scriptId: scriptId,
      enabled: enabled,
      cron: repeats ? cron.trimmingCharacters(in: .whitespaces) : nil,
      at: repeats ? nil : at.formatted(.iso8601),
      botId: botId)
  }

  var valid: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (scriptId != nil || !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      && (!repeats || !cron.trimmingCharacters(in: .whitespaces).isEmpty)
  }
}
