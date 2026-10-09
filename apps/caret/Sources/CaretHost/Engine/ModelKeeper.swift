import CaretHostCore
import Foundation

/// Which model file Caret runs, and Caret's own copy's download (brief item 8). Main thread. The download starts only
/// from `toggle`, which the menu item and the Writing tab's button call; a verified copy is used from the next launch,
/// since swapping the model under a running engine would cut off generations in flight.
@MainActor
final class ModelKeeper {
    /// The file loaded at launch, and where it came from; nil when none was found.
    let inUse: ModelFiles.Found?
    private(set) var state: ModelDownloadState = .idle {
        didSet { if state != oldValue { for o in observers { o() } } }
    }
    private var observers: [() -> Void] = []
    private var download: ModelDownload?
    private let folder: URL
    private let makeDownload: (URL) -> ModelDownload

    /// `downloadFolder`: where a download goes; nil is Caret's own models folder in `home`.
    init(configured: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser, downloadFolder: URL? = nil,
         exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) },
         makeDownload: @escaping (URL) -> ModelDownload = { ModelDownload(folder: $0) }) {
        let caret = ModelFiles.caretFile(home: home)
        let cotypist = home.appendingPathComponent(ModelFiles.cotypistFile)
        let source: ModelFiles.Source = configured.path == caret.path ? .caret : configured.path == cotypist.path ? .cotypist : .named
        inUse = source != .named && !exists(configured) ? nil : ModelFiles.Found(url: configured, source: source)
        folder = downloadFolder ?? caret.deletingLastPathComponent()
        self.makeDownload = makeDownload
    }

    func observe(_ body: @escaping () -> Void) { observers.append(body) }

    var line: String { ModelCopy.inUse(inUse) }
    func action(menu: Bool) -> String? { ModelCopy.action(inUse, state, menu: menu) }
    var status: String? { ModelCopy.status(state) }

    /// Starts the download, or stops the one running (keeping what came in).
    func toggle() {
        if state.isRunning {
            download?.stop()
            return
        }
        guard ModelCopy.action(inUse, state, menu: true) != nil else { return }
        let d = makeDownload(folder)
        download = d
        state = .downloading(received: ModelDownload.size(of: d.partURL) ?? 0, total: d.spec.bytes)
        d.onProgress = { [weak self] received, total in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, case .downloading = self.state else { return }
                    // The menu and the tab show whole percents; a redraw per 64 KiB chunk is wasted work.
                    if case .downloading(let was, _) = self.state, received < total, (received - was) * 200 < total { return }
                    self.state = received >= total ? .verifying : .downloading(received: received, total: total)
                }
            }
        }
        Task { [weak self] in
            do {
                _ = try await d.run()
                self?.state = .ready
            } catch let f as ModelDownload.Failure {
                self?.state = .failed(f.description)
            } catch {
                self?.state = .failed(error.localizedDescription)
            }
            self?.download = nil
        }
    }
}
