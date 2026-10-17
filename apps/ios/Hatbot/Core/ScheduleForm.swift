// A schedule as its page edits it (Views/SchedulesView.swift), apart from the view so it can be tested.
import Foundation

struct ScheduleForm: Equatable {
  var name = ""
  var repeats = true
  var cron = "0 8 * * *"
  var at = Date().addingTimeInterval(3600)
  var prompt = ""
  var enabled = true
  var botId = Bot.hatbot

  init() {}
  init(_ s: Schedule) {
    name = s.name
    repeats = s.cron != nil
    cron = s.cron ?? "0 8 * * *"
    at = Format.date(s.runAt) ?? Date().addingTimeInterval(3600)
    prompt = s.prompt
    enabled = s.enabled
    botId = s.botId ?? Bot.hatbot
  }

  /// The same schedule. A repeating one's `at` and a one-off's `cron` are only what the other choice
  /// would start from, and `at` is made from the clock: comparing them kept Save on for good.
  static func == (a: Self, b: Self) -> Bool {
    a.name == b.name && a.repeats == b.repeats && a.prompt == b.prompt && a.enabled == b.enabled
      && a.botId == b.botId && (a.repeats ? a.cron == b.cron : a.at == b.at)
  }

  var change: AppStore.ScheduleChange {
    AppStore.ScheduleChange(
      name: name.trimmingCharacters(in: .whitespacesAndNewlines),
      prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
      enabled: enabled,
      cron: repeats ? cron.trimmingCharacters(in: .whitespaces) : nil,
      at: repeats ? nil : at.formatted(.iso8601),
      botId: botId)
  }

  var valid: Bool {
    !name.trimmingCharacters(in: .whitespaces).isEmpty && !prompt.trimmingCharacters(in: .whitespaces).isEmpty
      && (!repeats || !cron.trimmingCharacters(in: .whitespaces).isEmpty)
  }
}
