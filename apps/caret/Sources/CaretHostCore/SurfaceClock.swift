import Foundation

/// Time and timers for `SurfaceMachine`: the half-second retry of a held offer, the visibility
/// recheck, the working line's tick and the result's lifetime. The app runs them on the main run
/// loop (CaretHost's `RunLoopClock`); tests advance a manual clock, so a 30 s hold or a 5 s toast
/// takes no real time.
public protocol SurfaceClock: AnyObject {
    var now: Date { get }
    /// Calls `fire` after `seconds`, and again every `seconds` when `repeats`, until cancelled.
    /// `fire` runs on the thread that owns the machine.
    func schedule(after seconds: TimeInterval, repeats: Bool, _ fire: @escaping () -> Void) -> SurfaceTimer
}

public protocol SurfaceTimer: AnyObject {
    func cancel()
}
