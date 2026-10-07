import CoreGraphics
import AppKit
// Prints frontmost app and on-screen windows (layer 0 and above) as tab-separated lines.
let front = NSWorkspace.shared.frontmostApplication
print("FRONT\t\(front?.processIdentifier ?? -1)\t\(front?.bundleIdentifier ?? "-")\t\(front?.localizedName ?? "-")")
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
  let num = w[kCGWindowNumber as String] as? Int ?? -1
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
  // H14: the origin and alpha too (appended, so readers of the first six columns are unchanged).
  print("WIN\t\(num)\t\(pid)\t\(owner)\t\(layer)\t\(b["Width"] ?? 0)x\(b["Height"] ?? 0)\t\(b["X"] ?? 0),\(b["Y"] ?? 0)\t\(alpha)")
}
