// The share sheet's Hatbot: what you share, with a note, goes to Hatbot's chat; text someone else wrote
// goes as a file, not as your words. It reads the token the app keeps in the App Group's Keychain
// access group.
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@objc(ShareViewController)
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    let host = UIHostingController(
      rootView: ShareView(providers: providers) { [weak self] sent in
        if sent {
          self?.extensionContext?.completeRequest(returningItems: nil)
        } else {
          self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
      })
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }
}

/// A file from the share sheet, ready to upload: a photo already scaled, anything else copied to a file
/// that goes up from disk, a piece at a time: the extension can't hold a big one in memory.
struct SharedFile: Identifiable {
  enum Content {
    case data(Data)
    case file(URL)
  }

  let id = UUID()
  var content: Content
  var name: String
  var mediaType: String
  var preview: UIImage?
}

/// What came of a file the share sheet lends.
private enum Lent {
  case file(SharedFile)
  /// Over the brain's 25 MB: not copied, and not sent.
  case tooBig(String)
  case unreadable
}

struct ShareView: View {
  let providers: [NSItemProvider]
  /// true: sent; false: cancelled.
  let done: (Bool) -> Void
  @State private var draft = ShareDraft()
  @State private var files: [SharedFile] = []
  /// Files left out for their size.
  @State private var tooBig: [String] = []
  @State private var loading = true
  @State private var sending = false
  @State private var error: String?
  private let api = AppGroup.api()

  var body: some View {
    NavigationStack {
      Form {
        if api == nil {
          Text("Open Hatbot and sign in first.").foregroundStyle(.secondary)
        }
        if let error { Text(error).foregroundStyle(.red) }
        if !tooBig.isEmpty {
          Text(
            tooBig.count == 1
              ? "\(tooBig[0]) is over 25 MB, so it's left out."
              : "\(tooBig.joined(separator: ", ")) are over 25 MB, so they're left out."
          )
          .foregroundStyle(.red)
        }
        Section {
          TextField("Add a note", text: $draft.note, axis: .vertical).lineLimit(2...8)
        }
        if !draft.texts.isEmpty || !draft.urls.isEmpty {
          Section {
            ForEach(draft.urls, id: \.self) { Text($0.absoluteString).lineLimit(2) }
            ForEach(draft.texts.filter { t in !draft.urls.contains { $0.absoluteString == t } }, id: \.self) {
              Text($0).lineLimit(6)
            }
          }
        }
        if !files.isEmpty {
          Section {
            ForEach(files) { f in
              HStack(spacing: 12) {
                if let preview = f.preview {
                  Image(uiImage: preview).resizable().scaledToFill().frame(width: 44, height: 44)
                    .clipShape(.rect(cornerRadius: 8))
                } else {
                  Image(systemName: "doc").frame(width: 44)
                }
                Text(f.name).lineLimit(1).truncationMode(.middle)
              }
            }
          }
        }
      }
      .overlay { if loading { ProgressView() } }
      .navigationTitle("Hatbot")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { done(false) } }
        ToolbarItem(placement: .confirmationAction) {
          Button(sending ? "Sending…" : "Send") { Task { await send() } }
            .disabled(api == nil || loading || sending || (draft.isEmpty && files.isEmpty))
        }
      }
    }
    .task { await load() }
    // The copies, sent or not.
    .onDisappear {
      for f in files {
        if case let .file(url) = f.content { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
      }
    }
  }

  private func load() async {
    for p in providers {
      if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
        // Numbered among the files, not among links and texts.
        if let photo = await Self.photo(p, index: files.count + 1) {
          files.append(
            SharedFile(content: .data(photo.data), name: photo.name, mediaType: "image/jpeg", preview: photo.preview))
        }
      } else if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        take(await Self.file(p))
      } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        if let url = await Self.url(p) { draft.urls.append(url) }
      } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        if let text = await Self.text(p) { draft.texts.append(text) }
      } else if let type = p.registeredTypeIdentifiers.compactMap(UTType.init).first(where: { $0.conforms(to: .data) }) {
        let name = p.suggestedName.map { $0 + (type.preferredFilenameExtension.map { ".\($0)" } ?? "") } ?? "file"
        take(await Self.copy(p, type, name: name))
      }
    }
    // What's listed is what's sent.
    files = Array(files.prefix(draft.fileRoom))
    loading = false
  }

  private func take(_ lent: Lent) {
    switch lent {
    case let .file(f): files.append(f)
    case let .tooBig(name): tooBig.append(name)
    case .unreadable: break
    }
  }

  private func send() async {
    guard let api else { return }
    sending = true
    error = nil
    do {
      var ids: [Int] = []
      // What was shared is someone else's words: a file, which Hatbot reads as untrusted.
      if !draft.shared.isEmpty {
        let a: Attachment = try await api.upload(
          "/attachments", data: Data(draft.shared.utf8), name: ShareDraft.sharedName, mediaType: "text/plain")
        ids.append(a.id)
      }
      for f in files {
        let a: Attachment
        switch f.content {
        case let .data(data): a = try await api.upload("/attachments", data: data, name: f.name, mediaType: f.mediaType)
        case let .file(url): a = try await api.upload("/attachments", file: url, name: f.name, mediaType: f.mediaType)
        }
        ids.append(a.id)
      }
      struct Post: Encodable {
        let text: String
        let attachmentIds: [Int]
      }
      let _: ThreadMessage = try await api.post("/thread/messages", body: Post(text: draft.text, attachmentIds: ids))
      done(true)
    } catch {
      self.error = (error as? APIError)?.message ?? "Couldn't reach Hatbot."
    }
    sending = false
  }

  private static func url(_ p: NSItemProvider) async -> URL? {
    await withCheckedContinuation { c in
      _ = p.loadObject(ofClass: URL.self) { url, _ in c.resume(returning: url) }
    }
  }

  private static func text(_ p: NSItemProvider) async -> String? {
    await withCheckedContinuation { c in
      _ = p.loadObject(ofClass: String.self) { text, _ in c.resume(returning: text) }
    }
  }

  /// A photo, scaled from the file the share sheet lends while it lends it (off the main thread).
  private static func photo(_ p: NSItemProvider, index: Int) async -> PickedFile.Photo? {
    let photo: PickedFile.Photo? = await withCheckedContinuation { c in
      _ = p.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
        c.resume(returning: url.flatMap { PickedFile.photo(at: $0, index: index) })
      }
    }
    if let photo { return photo }
    // Some apps share a picture only as data.
    let data: Data? = await withCheckedContinuation { c in
      _ = p.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in c.resume(returning: data) }
    }
    return data.flatMap { PickedFile.photo($0, index: index) }
  }

  /// Anything else as a file of our own, copied while the share sheet lends it.
  private static func copy(_ p: NSItemProvider, _ type: UTType, name: String) async -> Lent {
    await withCheckedContinuation { c in
      _ = p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        c.resume(returning: lend(url, name: name, mediaType: type.preferredMIMEType ?? "application/octet-stream"))
      }
    }
  }

  /// A file from Files or another app.
  private static func file(_ p: NSItemProvider) async -> Lent {
    await withCheckedContinuation { c in
      _ = p.loadObject(ofClass: URL.self) { url, _ in
        c.resume(returning: lend(url, name: url?.lastPathComponent ?? "file", mediaType: url.map(PickedFile.mediaType) ?? ""))
      }
    }
  }

  /// The size is checked before anything is copied or read.
  private static func lend(_ url: URL?, name: String, mediaType: String) -> Lent {
    guard let url else { return .unreadable }
    if (PickedFile.size(url) ?? 0) > API.maxUpload { return .tooBig(name) }
    guard let copy = PickedFile.copy(url, name: name) else { return .unreadable }
    return .file(SharedFile(content: .file(copy), name: name, mediaType: mediaType))
  }
}
