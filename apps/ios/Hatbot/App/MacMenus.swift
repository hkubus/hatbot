#if targetEnvironment(macCatalyst)
  import SwiftUI

  /// What the menu bar does in the window in front, while you're signed in.
  struct MenuActions {
    var show: (AppTab) -> Void
    var newMessage: () -> Void
    /// To the chat above (-1) or below (1) in the sidebar.
    var moveChat: (Int) -> Void
  }

  extension FocusedValues {
    @Entry var menuActions: MenuActions?
  }

  /// The menu bar, with the web app's shortcuts where it has them: Command-K for Search, and Option-Up and
  /// Option-Down for the chat above or below.
  struct MacMenus: Commands {
    @FocusedValue(\.menuActions) private var actions

    var body: some Commands {
      CommandGroup(replacing: .appSettings) {
        Button("Settings…") { actions?.show(.settings) }
          .keyboardShortcut(",")
          .disabled(actions == nil)
      }
      CommandGroup(replacing: .newItem) {
        Button("New Message") { actions?.newMessage() }
          .keyboardShortcut("n")
          .disabled(actions == nil)
      }
      CommandGroup(before: .toolbar) {
        // Its own section, or they come out backwards.
        Section {
          Button("Make Text Bigger") { TextSize.shared.step(1) }.keyboardShortcut("+")
          Button("Make Text Normal Size") { TextSize.shared.reset() }.keyboardShortcut("0")
          Button("Make Text Smaller") { TextSize.shared.step(-1) }.keyboardShortcut("-")
        }
      }
      CommandMenu("Go") {
        Group {
          Button("Search") { actions?.show(.search) }.keyboardShortcut("k")
          Divider()
          let sections: [AppTab] = [.chat, .tasks, .todo, .boxes, .live, .memory]
          ForEach(Array(sections.enumerated()), id: \.element) { i, t in
            Button(t.title) { actions?.show(t) }.keyboardShortcut(KeyEquivalent(Character("\(i + 1)")))
          }
          Divider()
          Button("Previous Chat") { actions?.moveChat(-1) }.keyboardShortcut(.upArrow, modifiers: .option)
          Button("Next Chat") { actions?.moveChat(1) }.keyboardShortcut(.downArrow, modifiers: .option)
        }
        .disabled(actions == nil)
      }
    }
  }
#endif
