// Files in the chat: the ones on messages (pictures inline, the rest open in Quick Look) and the ones
// waiting in the composer while they upload.
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// A message's files, aligned to its side.
struct MessageFiles: View {
  let list: [Attachment]
  let alignment: HorizontalAlignment

  var body: some View {
    VStack(alignment: alignment, spacing: 6) {
      ForEach(list) { a in
        if a.isPicture { PictureFile(attachment: a) } else { FileRow(attachment: a) }
      }
    }
  }
}

/// A picture on a message; a tap opens it full screen.
private struct PictureFile: View {
  static let side: CGFloat = 240
  let attachment: Attachment
  @Environment(AppStore.self) private var store
  @Environment(\.displayScale) private var scale
  @State private var image: UIImage?
  @State private var failed = false
  @State private var full = false

  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
      } else {
        Rectangle().fill(.quaternary)
          .aspectRatio(4 / 3, contentMode: .fit)
          .overlay { if failed { Image(systemName: "photo").foregroundStyle(.secondary) } else { ProgressView() } }
      }
    }
    .frame(maxWidth: Self.side, maxHeight: Self.side)
    .clipShape(.rect(cornerRadius: 14))
    .contentShape(.rect)
    .onTapGesture { if image != nil { full = true } }
    .fullScreenCover(isPresented: $full) {
      if let image { FullPicture(api: store.api, attachment: attachment, small: image) }
    }
    .task(id: attachment.id) {
      do {
        image = try await ImageCache.attachments.image(
          store.api, "/attachments/\(attachment.id)", longSide: Self.side * scale)
      } catch {
        failed = true
      }
    }
    .accessibilityLabel(attachment.name)
  }
}

/// A picture full screen: the chat's copy at once, then one sharp enough to zoom into.
private struct FullPicture: View {
  let api: API
  let attachment: Attachment
  let small: UIImage
  @State private var large: UIImage?

  var body: some View {
    ImageViewer(image: large ?? small, label: attachment.name)
      .task {
        large = try? await ImageCache.attachments.image(api, "/attachments/\(attachment.id)", longSide: 3000, keep: false)
      }
  }
}

/// Any other file: its name; a tap opens it in Quick Look, which can share or save it.
private struct FileRow: View {
  let attachment: Attachment
  @Environment(AppStore.self) private var store
  @State private var url: URL?
  @State private var loading = false

  var body: some View {
    Button {
      guard !loading else { return }
      loading = true
      Task {
        url = try? await file()
        loading = false
      }
    } label: {
      HStack(spacing: 8) {
        if loading { ProgressView().controlSize(.small) } else { Image(systemName: "doc") }
        Text(attachment.name).lineLimit(1).truncationMode(.middle)
      }
      .font(.subheadline)
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: 260, alignment: .leading)
      .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 12))
    }
    .buttonStyle(.plain)
    .quickLookPreview($url)
  }

  /// The file saved where Quick Look can open it, under its own name.
  private func file() async throws -> URL {
    let dir = DiskCache.openedFiles.appendingPathComponent("\(attachment.id)", isDirectory: true)
    let url = dir.appendingPathComponent(attachment.name.replacingOccurrences(of: "/", with: "_"))
    if FileManager.default.fileExists(atPath: url.path) { return url }
    let data = try await store.api.data("/attachments/\(attachment.id)?download")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try data.write(to: url)
    return url
  }
}

/// A photo from the library as a file of our own, so it isn't read into memory whole.
struct PickedPhoto: Transferable {
  let url: URL

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      // The file is the picker's only until this returns.
      try PickedPhoto(url: PickedFile.copy(received.file))
    }
  }
}

/// A file in the composer: uploading, uploaded, or failed.
struct ComposerFile: Identifiable {
  let id = UUID()
  let name: String
  var preview: UIImage?
  var attachment: Attachment?
  var error: String?
}

/// The files waiting in the composer, with a button to take each out.
struct ComposerFiles: View {
  let files: [ComposerFile]
  let remove: (UUID) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(files) { f in
          Group {
            if let preview = f.preview {
              Image(uiImage: preview).resizable().scaledToFill().frame(width: 56, height: 56)
            } else {
              HStack(spacing: 6) {
                Image(systemName: "doc")
                Text(f.name).lineLimit(1).truncationMode(.middle)
              }
              .font(.footnote)
              .padding(.horizontal, 10)
              .frame(maxWidth: 200, minHeight: 56)
            }
          }
          .background(.quaternary.opacity(0.6))
          .clipShape(.rect(cornerRadius: 12))
          .overlay {
            RoundedRectangle(cornerRadius: 12)
              .strokeBorder(f.error == nil ? Color.clear : Color.red, lineWidth: 1)
          }
          .opacity(f.attachment == nil && f.error == nil ? 0.5 : 1)
          .overlay(alignment: .topTrailing) {
            Button {
              remove(f.id)
            } label: {
              Image(systemName: "xmark.circle.fill")
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, .black.opacity(0.55))
            }
            .padding(3)
            .accessibilityLabel("Remove \(f.name)")
          }
        }
      }
      .padding(.horizontal, 4)
    }
  }
}
