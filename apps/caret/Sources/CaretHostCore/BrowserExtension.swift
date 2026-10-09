import Foundation

/// Where "Add to <browser>" sends the person for Caret for Chrome itself. Until the Chrome Web Store listing exists
/// it is nil, and the step opens the browser's Extensions page with the three Load unpacked steps
/// (`BrowserInstallPlan.manualSteps`). Once the listing exists, its URL goes here and nothing else changes.
public enum BrowserExtension {
    public static let storeURL: URL? = nil
}
