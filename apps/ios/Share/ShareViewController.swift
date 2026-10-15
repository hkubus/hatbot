// The share sheet's Hatbot: what you share, with a note, goes to Hatbot's chat as you. It reads the
// token the app keeps in the App Group's Keychain access group.
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

/// A file read from the share sheet, ready to upload.
struct SharedFile: Identifiable {
  let id = UUID()
  var data: Data
  var name: String
  var mediaType: String
  var preview: UIImage?
}

struct ShareView: View {
  let providers: [NSItemProvider]
  /// true: sent; false: cancelled.
  let done: (Bool) -> Void
  @State private var draft = ShareDraft()
  @State private var files: [SharedFile] = []
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
            .disabled(api == nil || loading || sending || (draft.text.isEmpty && files.isEmpty))
        }
      }
    }
    .task { await load() }
  }

  private func load() async {
    for (i, p) in providers.enumerated() {
      if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
        if let data = await Self.data(p, UTType.image), let photo = PickedFile.photo(data, index: i + 1) {
          files.append(SharedFile(data: photo.data, name: photo.name, mediaType: "image/jpeg", preview: photo.preview))
        }
      } else if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        if let f = await Self.file(p) { files.append(f) }
      } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        if let url = await Self.url(p) { draft.urls.append(url) }
      } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        if let text = await Self.text(p) { draft.texts.append(text) }
      } else if let type = p.registeredTypeIdentifiers.compactMap(UTType.init).first(where: { $0.conforms(to: .data) }) {
        if let data = await Self.data(p, type) {
          let name = p.suggestedName.map { $0 + (type.preferredFilenameExtension.map { ".\($0)" } ?? "") } ?? "file"
          files.append(SharedFile(data: data, name: name, mediaType: type.preferredMIMEType ?? "application/octet-stream"))
        }
      }
    }
    files = Array(files.prefix(10))
    loading = false
  }

  private func send() async {
    guard let api else { return }
    sending = true
    error = nil
    do {
      var ids: [Int] = []
      for f in files {
        let a: Attachment = try await api.upload("/attachments", data: f.data, name: f.name, mediaType: f.mediaType)
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

  private static func data(_ p: NSItemProvider, _ type: UTType) async -> Data? {
    await withCheckedContinuation { c in
      _ = p.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in c.resume(returning: data) }
    }
  }

  /// A file, read while the share sheet lends it.
  private static func file(_ p: NSItemProvider) async -> SharedFile? {
    await withCheckedContinuation { c in
      _ = p.loadObject(ofClass: URL.self) { url, _ in
        guard let url, let f = PickedFile.file(url) else { return c.resume(returning: nil) }
        c.resume(returning: SharedFile(data: f.data, name: f.name, mediaType: f.mediaType))
      }
    }
  }
}
