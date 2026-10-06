// J1: whether Apple's on-device model can answer on this Mac. Prints one line: "available", or "unavailable <reason>".
// Run by apple.ts as `xcrun swift <this file>`.
import FoundationModels

switch SystemLanguageModel.default.availability {
case .available:
    print("available")
case .unavailable(.deviceNotEligible):
    print("unavailable deviceNotEligible")
case .unavailable(.appleIntelligenceNotEnabled):
    print("unavailable appleIntelligenceNotEnabled")
case .unavailable(.modelNotReady):
    print("unavailable modelNotReady")
case .unavailable(let other):
    print("unavailable \(other)")
}
