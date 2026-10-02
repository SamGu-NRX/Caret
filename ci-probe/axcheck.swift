import ApplicationServices
import CoreGraphics
import AppKit
print("AXIsProcessTrusted:", AXIsProcessTrusted())
print("ScreenCapturePreflight:", CGPreflightScreenCaptureAccess())
print("ListenEventPreflight:", CGPreflightListenEventAccess())
print("PostEventPreflight:", CGPreflightPostEventAccess())
print("Frontmost:", NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "none")
