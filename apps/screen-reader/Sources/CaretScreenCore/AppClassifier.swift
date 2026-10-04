import Foundation

/// Which engine renders an app's web content, read from its bundle (browser layer memo, section 4; W2).
///
/// `electron`: an app built on Electron, whose framework is `Contents/Frameworks/Electron Framework.framework`.
/// `chromiumBrowser`: a Chromium browser (Chrome, Chrome for Testing, Helium, Brave, Edge): a framework under
/// `Contents/Frameworks` that ships a renderer helper app in `Versions/*/Helpers`, the way every Chromium build does.
/// `other`: anything else, including WebKit apps.
public enum AppFamily: String, Sendable, Equatable {
    case electron, chromiumBrowser, other

    /// Chromium renders the app's web pages itself (Electron or a Chromium browser): its web areas are not WebKit's.
    public var rendersWithChromium: Bool { self != .other }

    /// Whether the reader sets AXManualAccessibility on the app. Only Electron implements it. Chromium's mac code does
    /// not handle it (the -25205 in the reader's log), and Caret reads browser pages through its page engine, so a
    /// Chromium browser is never asked.
    public var setsManualAccessibility: Bool { self == .electron }
}

public enum AppClassifier {
    /// The app's family from the bundle at `bundleURL`. Electron is checked first: an Electron app also ships renderer
    /// helpers, but directly in `Contents/Frameworks`, not inside a framework's `Versions`.
    public static func family(bundleURL: URL, fileManager fm: FileManager = .default) -> AppFamily {
        let frameworks = bundleURL.appendingPathComponent("Contents/Frameworks")
        guard let items = try? fm.contentsOfDirectory(atPath: frameworks.path) else { return .other }
        if items.contains("Electron Framework.framework") { return .electron }
        for f in items where f.hasSuffix(".framework") {
            let versions = frameworks.appendingPathComponent(f).appendingPathComponent("Versions")
            for v in (try? fm.contentsOfDirectory(atPath: versions.path)) ?? [] {
                let helpers = versions.appendingPathComponent(v).appendingPathComponent("Helpers")
                if let hs = try? fm.contentsOfDirectory(atPath: helpers.path), hs.contains(where: { $0.contains("Helper (Renderer)") }) {
                    return .chromiumBrowser
                }
            }
        }
        return .other
    }
}
