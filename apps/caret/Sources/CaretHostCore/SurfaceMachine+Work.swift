import CaretScreenCore
import Foundation

// Work after Tab: the working line, its result, the fill toast and its undo.
extension SurfaceMachine {
    /// The line, in place, becomes the working caption; the figure looks away and leaves.
    func startWork(_ claim: Claim, offerKey: String) {
        endWork()
        endResult()
        lineSuppressed = false
        let pid = claim.offer.target.pid
        var fill: FillWork?
        let app: String
        switch claim.offer.kind {
        case .action(let line):
            app = line.app
        case .popup(let popup):
            app = world.appName(pid: pid) ?? "the app"
            let spec = claim.choice.revealed.map { popup.spec.applyingReveal(of: $0) } ?? popup.spec
            if let rows = spec.fillRows { fill = FillWork(rows: rows, source: OfferLifecycle.sourcePhrase(popup.sourceApps)) }
        case .ghost, .fill:
            app = world.appName(pid: pid) ?? "the app"
        }
        let now = clock.now
        let statusID = arbiter.showStatus(StatusLine(pid: pid, kind: .working(startedAt: now), offerKey: offerKey))
        work = Work(
            offerKey: offerKey, app: app, pid: pid, statusID: statusID, startedAt: now,
            source: claim.offer.source, target: claim.offer.target, fill: fill
        )
        // The figure looks away (160 ms), then leaves; under Reduce Motion it is simply gone.
        work?.figureLeft = world.reduceMotion
        renderWorking()
        if work?.figureLeft == false {
            workTimers.append(clock.schedule(after: 0.2, repeats: false) { [weak self] in
                guard let self, self.work?.statusID == statusID else { return }
                self.work?.figureLeft = true
                self.renderWorking()
            })
        }
        workTimers.append(clock.schedule(after: 1, repeats: true) { [weak self] in self?.renderWorking() })
        emit(.workingChanged(true))
    }

    func renderWorking() {
        guard let work else { return }
        let line = WorkLines.working(
            app: work.app, fillRows: work.fill?.rows, character: world.character,
            seconds: Int(clock.now.timeIntervalSince(work.startedAt)), figureLeft: work.figureLeft
        )
        // A key dismissed the line, or its app went behind: the work goes on unseen.
        guard arbiter.snapshot().statusLine?.id == work.statusID, !lineSuppressed else { return }
        lineText = line.text
        figure = .working
        if !headless {
            showPanel(.line(line.content), text: line.text, placement: .inPlace)
        }
        publish()
    }

    /// The helper's progress on a task. The work an accepted offer started runs as the task whose
    /// id is the offer's key; its last phase (done, stopped, handoff or paused) ends the line.
    public func taskProgress(_ progress: TaskProgress) {
        if progress.phase == .undone, undoing == progress.taskId {
            return finishUndo(progress)
        }
        if work == nil, let stopped = stoppedWork, stopped.offerKey == progress.taskId {
            return confirmStop(stopped, progress)
        }
        if work?.offerKey == progress.taskId {
            if progress.steps > 0 { work?.steps = progress.steps }
            switch progress.phase {
            case .verified, .skipped: if let step = progress.step { work?.nextStep = step + 1 }
            case .acting: if let step = progress.step { work?.nextStep = step }
            default: break
            }
            if progress.phase == .verified { work?.verified += 1 }
            if progress.phase == .done { work?.written = progress.written }
        }
        guard let ending = OfferLifecycle.ending(of: progress, workKey: work?.offerKey) else { return publish() }
        count("surface.progress.\(progress.phase.rawValue)")
        end(with: ending)
    }

    /// `progress done|error` on the debug socket (test hooks only): ends the line as a run would.
    public func progress(_ phase: String) -> String {
        guard work != nil else { return #"{"error":"no work running"}"# }
        switch phase {
        case "done": end(with: .done)
        case "error": end(with: .stopped(reason: .error, step: nil, steps: 0, detail: "debug socket"))
        default: return #"{"error":"phase is done or error"}"#
        }
        return #"{"ok":true}"#
    }

    func end(with ending: OfferLifecycle.Ending) {
        guard let work else { return }
        endWork()
        guard headless || !lineSuppressed else {
            // The line went down when its app went behind; its result is not drawn, so it takes no
            // key either.
            takeLineDown(exit: 0)
            return publish()
        }
        switch ending {
        case .done:
            // `written` counts each field once; an older helper sends none, and the verified steps stand in.
            let filled = work.written ?? work.verified
            if let fill = work.fill, filled > 0 {
                return showUndoToast(work, WorkLines.filled(filled, from: fill.source), kind: "surface.toast.fill")
            }
            // An action that wrote something: its task's ledger can restore it, so ⌘Z takes the
            // line as it takes a fill's. Only the helper's own count says it wrote; presses alone
            // have nothing to undo.
            if work.fill == nil, work.source == .helper, (work.written ?? 0) > 0 {
                return showUndoToast(work, WorkLines.done(app: work.app, character: world.character, undo: true), kind: "surface.toast.action")
            }
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .result, offerKey: work.offerKey))
            showResult(WorkLines.done(app: work.app, character: world.character), lifetime: 5)
        case .stopped(let reason, let step, let steps, _):
            let line = WorkLines.stopped(
                app: work.app, reason: reason, next: step ?? work.nextStep, steps: steps > 0 ? steps : (work.steps ?? 0),
                fillFilled: work.fill.map { _ in work.verified }
            )
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: reason == .you ? .result : .error, offerKey: work.offerKey))
            showResult(line, lifetime: reason == .you ? 3 : 6)
        case .handoff:
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .result, offerKey: work.offerKey))
            showResult(WorkLines.handoff(app: work.app), lifetime: 6)
        case .paused:
            // The input pause stopped the run; the perch and the activity list carry it from here.
            takeLineDown(exit: 0.08)
            publish()
        case .helperDown:
            // No taskProgress will come, so the line says so rather than work on forever. The same
            // line as onboarding's first look when nothing ran.
            let wrote = work.written ?? work.verified
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .error, offerKey: work.offerKey))
            showResult(wrote == 0 ? WorkLines.acceptUnsent : WorkLines.helperStopped, lifetime: 6)
        }
    }

    /// "Filled 3 fields from Mail  ⌘Z Undo", or "Done, in TextEdit  ⌘Z Undo": ⌘Z belongs to
    /// Caret while it shows, and asks the helper to undo the task (`SURFACES.md` section 6).
    func showUndoToast(_ work: Work, _ line: WorkLine, kind: String) {
        let grant = UndoGrant.task(work.offerKey, target: work.target, createdAt: clock.now)
        let id = arbiter.showToast(grant)
        toastGrantID = id
        emit(.toastSlotTaken)
        toastInfo = DebugState.Toast(kind: "done", caption: line.text, grantID: id)
        count(kind)
        showResult(line, lifetime: grant.lifetimeSeconds)
    }

    /// ⌘Z took the fill toast. The undo is tracked before it is requested, so the helper's answer
    /// always finds it; the line says so until the answer comes, or for 10 s.
    public func undoStarted(_ grant: UndoGrant) {
        guard let taskID = grant.taskID else { return }
        if toastGrantID == grant.id { toastGrantID = nil }
        undoing = taskID
        let sent = sendToHelper(.control(TaskControl(taskId: taskID, action: .undo)))
        count(sent ? "surface.undo.sent" : "surface.undo.unsent")
        // A newer offer or run may have taken the panel since the key; the undo then reports nowhere.
        guard shown == nil, work == nil else {
            toastInfo = nil
            return publish()
        }
        guard sent else {
            undoing = nil
            toastInfo = DebugState.Toast(kind: "error", caption: WorkLines.undoUnsent.text, grantID: nil)
            return showResult(WorkLines.undoUnsent, lifetime: 6)
        }
        toastInfo = DebugState.Toast(kind: "undoing", caption: WorkLines.undoing.text, grantID: nil)
        showResult(WorkLines.undoing, lifetime: 10)
    }

    /// The fill line's toast took the arbiter's toast slot: this machine's toast, if any, is gone.
    public func toastChanged() {
        guard let toastGrantID, arbiter.snapshot().toast?.id != toastGrantID else { return }
        self.toastGrantID = nil
        toastInfo = nil
        cancelResultTimer()
        takeLineDown(exit: 0.08)
        publish()
    }

    func finishUndo(_ progress: TaskProgress) {
        undoing = nil
        guard shown == nil, work == nil else { return publish() }
        let line = WorkLines.undone(OfferLifecycle.undoCount(progress))
        let partial = line.content.figure == .error
        toastInfo = DebugState.Toast(kind: partial ? "error" : "undone", caption: line.text, grantID: nil)
        count("surface.undo.\(partial ? "partial" : "done")")
        showResult(line, lifetime: partial ? 6 : 2)
    }

    /// Esc on a working line after 3 s: stop, and say so for 3 s. Work the helper runs is stopped
    /// there too (`offerStop`); what it already wrote stays, as the activity list's undo can restore.
    /// The line names the step from the progress seen so far; the helper's own ending corrects it
    /// (`confirmStop`).
    public func stopWork(_ line: StatusLine) {
        guard let work, work.statusID == line.id else { return }
        if work.source == .helper { _ = sendToHelper(.stop(OfferStop(offerId: work.offerKey, at: nowMs))) }
        endWork()
        count("surface.workStopped")
        guard !lineSuppressed else {
            // The tap took Esc, then the line went down before this ran: nobody sees "Stopped", so
            // it is not shown and takes no key.
            takeLineDown(exit: 0)
            return publish()
        }
        resultStatusID = arbiter.showStatus(StatusLine(pid: line.pid, kind: .result, offerKey: line.offerKey))
        // Where it stopped: the helper stops before the step it has not finished, as the activity
        // list says it.
        let steps = work.steps ?? 0
        showResult(WorkLines.stoppedByYou(next: work.nextStep ?? (steps > 0 ? 0 : nil), of: steps), lifetime: 3)
        if work.source == .helper { stoppedWork = work }
    }

    /// The helper's ending for work Esc stopped, while its line still shows. A stop names the step
    /// the helper stopped before; a run that finished before the stop reached it says Done. The
    /// line keeps its place and its timer; anything else the run reports changes nothing.
    func confirmStop(_ stopped: Work, _ progress: TaskProgress) {
        guard resultStatusID != nil, !lineSuppressed || headless else { return }
        let line: WorkLine
        switch progress.phase {
        case .stopped:
            let steps = progress.steps > 0 ? progress.steps : (stopped.steps ?? 0)
            line = WorkLines.stoppedByYou(next: progress.step ?? stopped.nextStep, of: steps)
        case .done:
            line = WorkLines.done(app: stopped.app, character: world.character)
        default:
            return
        }
        stoppedWork = nil
        guard line.text != lineText else { return publish() }
        count("surface.stop.corrected")
        lineText = line.text
        figure = line.content.figure
        if !headless { showPanel(.line(line.content), text: line.text, placement: .inPlace) }
        publish()
    }

    func endResult() {
        stoppedWork = nil
        cancelResultTimer()
        if let id = resultStatusID { arbiter.clearStatus(id: id) }
        resultStatusID = nil
        if let id = toastGrantID { arbiter.dismissToast(grantID: id) }
        toastGrantID = nil
        undoing = nil
        toastInfo = nil
    }

    func endWork() {
        for timer in workTimers { timer.cancel() }
        workTimers = []
        guard let work else { return }
        arbiter.clearStatus(id: work.statusID)
        self.work = nil
        emit(.workingChanged(false))
    }

    func cancelResultTimer() {
        resultTimer?.cancel()
        resultTimer = nil
    }

    /// The working line becomes the result where it stands, and leaves after `lifetime`.
    func showResult(_ line: WorkLine, lifetime: TimeInterval) {
        let content = line.content
        let text = line.text
        lineText = text
        figure = content.figure
        if !headless, !lineSuppressed {
            showPanel(.line(content), text: text, placement: .inPlace)
        }
        cancelResultTimer()
        let statusID = resultStatusID
        let grantID = toastGrantID
        resultTimer = clock.schedule(after: lifetime, repeats: false) { [weak self] in
            guard let self, self.resultStatusID == statusID, self.toastGrantID == grantID else { return }
            self.resultTimer = nil
            self.endResult()
            self.takeLineDown(exit: 0.20)
            self.publish()
        }
        publish()
    }
}
