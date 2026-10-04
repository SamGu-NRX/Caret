import CaretScreenCore
import Foundation

// Work after Tab, and work a skill started with no Tab (B19): the working line, its result, the
// toast and its undo, and a keep or promote question under that result.
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
        case .ghost, .fill, .writing:
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
        let line = work.unprompted
            ? WorkLines.onItsOwn(work.name ?? "A skill", app: work.app)
            : WorkLines.working(
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
        // Any ending answers a stop sent for this task, whether or not its line still shows.
        switch progress.phase {
        case .stopped, .done, .paused, .handoff: stopDeadlines.removeValue(forKey: progress.taskId)?.cancel()
        case .started, .skipped, .acting, .verified, .undone: break
        }
        if progress.phase == .undone, undoing == progress.taskId {
            return finishUndo(progress)
        }
        if progress.unprompted == true, work?.offerKey != progress.taskId, stoppedWork?.offerKey != progress.taskId {
            // Drawn once already, and since replaced: the perch and the activity list carry it on.
            if unpromptedDrawn.contains(progress.taskId) { return publish() }
            // A skill's run with no Tab: drawn at the caret once its record says where (`activity`).
            // One that ends before then, or is never drawn, is the perch's and the activity list's.
            if OfferLifecycle.ending(of: progress, workKey: progress.taskId) != nil || progress.phase == .undone {
                unpromptedSeen.remove(progress.taskId)
                return publish()
            }
            unpromptedSeen.insert(progress.taskId)
            guard startUnprompted(progress.taskId) else { return publish() }
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
        result = Result(taskID: work.offerKey, target: work.target, anchor: work.anchor, line: WorkLines.undoing)
        switch ending {
        case .done:
            if work.unprompted, (work.written ?? 0) > 0 {
                return showUndoToast(work, WorkLines.doneOnItsOwn(work.name ?? "A skill"), kind: "surface.toast.unprompted", lifetime: Self.unpromptedToastLifetime)
            }
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
        case .handoff(let blocked, let field):
            resultStatusID = arbiter.showStatus(StatusLine(pid: work.pid, kind: .result, offerKey: work.offerKey))
            showResult(blocked.map(WorkLines.blocked) ?? field.map { WorkLines.handedField($0, app: work.app) } ?? WorkLines.handoff(app: work.app), lifetime: 6)
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
    func showUndoToast(_ work: Work, _ line: WorkLine, kind: String, lifetime: TimeInterval = UndoGrant.defaultLifetime) {
        let grant = UndoGrant.task(work.offerKey, target: work.target, createdAt: clock.now, lifetimeSeconds: lifetime)
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
        // ⌘Z undoes the run the question was about: it goes unanswered.
        dropQuestion("surface.skill.undone")
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
        dropQuestion("surface.skill.toastTaken")
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

    /// Esc on a working line after 3 s: stop. Work the helper runs is stopped there (`offerStop`, or
    /// a take over for a skill's run with no Tab), and the line says "Stopping…" until the helper's
    /// own ending says where it stopped (`confirmStop`), never "Stopped" before it (S1 audit #17).
    /// What it already wrote stays, as the activity list's undo can restore. A stop that cannot be
    /// delivered, or is never answered, says so and closes the connection, which makes the helper
    /// revoke the work this session accepted (B22).
    public func stopWork(_ line: StatusLine) {
        guard let work, work.statusID == line.id else { return }
        let helperWork = work.unprompted || work.source == .helper
        var delivered = true
        // A skill's run with no Tab is handed back, not ended: it pauses where it is, and the
        // activity list offers Continue (plan section 3, "Take over").
        if work.unprompted {
            delivered = sendToHelper(.control(TaskControl(taskId: work.offerKey, action: .takeOver)))
        } else if work.source == .helper {
            delivered = sendToHelper(.stop(OfferStop(offerId: work.offerKey, at: nowMs)))
        }
        endWork()
        count("surface.workStopped")
        if !delivered {
            count("surface.stop.unsent")
            emit(.dropHelperSession)
        } else if helperWork {
            armStopDeadline(work.offerKey)
        }
        guard !lineSuppressed else {
            // The tap took Esc, then the line went down before this ran: nobody sees the line, so
            // it is not shown and takes no key.
            takeLineDown(exit: 0)
            return publish()
        }
        resultStatusID = arbiter.showStatus(StatusLine(pid: line.pid, kind: delivered ? .result : .error, offerKey: line.offerKey))
        result = Result(taskID: work.offerKey, target: work.target, anchor: work.anchor, line: WorkLines.undoing)
        guard helperWork else {
            // The host's own work stops here and now. Where it stopped: before the step it had not
            // finished, as the activity list says it.
            let steps = work.steps ?? 0
            return showResult(WorkLines.stoppedByYou(next: work.nextStep ?? (steps > 0 ? 0 : nil), of: steps), lifetime: Self.stoppedLineLifetime)
        }
        guard delivered else { return showResult(WorkLines.stopUnreached, lifetime: Self.stopUnreachedLifetime) }
        // The helper stops at its next step boundary, which a slow step can put seconds away (A14's
        // Esc 1 of 3; A15 part 1): the line waits for that ending, and lives its 3 s from there.
        stoppedWork = work
        showResult(WorkLines.stopping, lifetime: Self.stopConfirmWait + Self.stopUnreachedLifetime)
    }

    /// The stop's deadline (`stopDeadlines`): missed, the session closes so the helper revokes the
    /// run (B22), and a "Stopping…" line still up for it says the run may still be going.
    func armStopDeadline(_ taskID: String) {
        stopDeadlines[taskID]?.cancel()
        stopDeadlines[taskID] = clock.schedule(after: Self.stopConfirmWait, repeats: false) { [weak self] in
            guard let self, self.stopDeadlines.removeValue(forKey: taskID) != nil else { return }
            self.count("surface.stop.unconfirmed")
            self.emit(.dropHelperSession)
            if self.stoppedWork?.offerKey == taskID { self.stopUnconfirmed() } else { self.publish() }
        }
    }

    /// The helper never said the run stopped: the "Stopping…" line, if it is still up, says so plainly.
    func stopUnconfirmed() {
        stoppedWork = nil
        guard let statusID = resultStatusID, arbiter.snapshot().statusLine?.id == statusID, headless || !lineSuppressed else { return publish() }
        if let r = result { resultStatusID = arbiter.showStatus(StatusLine(pid: r.target.pid, kind: .error, offerKey: r.taskID)) }
        showResult(WorkLines.stopUnreached, lifetime: Self.stopUnreachedLifetime)
    }

    /// The helper's ending for work Esc stopped, while its line still shows. A stop names the step
    /// the helper stopped before, or the failure that ended the run first; a run that finished
    /// before the stop reached it says Done. The line keeps its place, and its lifetime starts now;
    /// progress that is not an ending changes nothing. A line a key already took down stays down.
    func confirmStop(_ stopped: Work, _ progress: TaskProgress) {
        guard let statusID = resultStatusID, resultTimer != nil, arbiter.snapshot().statusLine?.id == statusID,
              !lineSuppressed || headless else {
            stoppedWork = nil
            return
        }
        let steps = progress.steps > 0 ? progress.steps : (stopped.steps ?? 0)
        let line: WorkLine
        switch progress.phase {
        case .stopped:
            line = WorkLines.stopped(
                app: stopped.app, reason: progress.stopReason ?? .error, next: progress.step ?? stopped.nextStep, steps: steps,
                fillFilled: stopped.fill.map { _ in stopped.verified }
            )
        case .done:
            line = WorkLines.done(app: stopped.app, character: world.character)
        case .paused where stopped.unprompted:
            // Take over pauses the run at its next step boundary; the helper names that step.
            line = WorkLines.tookOver(next: progress.step ?? stopped.nextStep, of: steps)
        case .paused:
            // Paused another way before the stop reached it (the user's own input): it acts no more.
            line = WorkLines.stoppedByYou(next: progress.step ?? stopped.nextStep, of: steps)
        case .handoff:
            // It reached the press it leaves to the user before the stop reached it.
            line = progress.blocked.map(WorkLines.blocked) ?? HandedField.parse(progress.detail).map { WorkLines.handedField($0, app: stopped.app) }
                ?? WorkLines.handoff(app: stopped.app)
        default:
            // Not an ending: the line keeps waiting.
            return
        }
        stoppedWork = nil
        // What Esc alone would have said; the helper's ending differs when a step finished first.
        let predicted = stopped.unprompted
            ? WorkLines.tookOver(next: stopped.nextStep ?? (steps > 0 ? 0 : nil), of: steps)
            : WorkLines.stoppedByYou(next: stopped.nextStep ?? (steps > 0 ? 0 : nil), of: steps)
        if line.text != predicted.text { count("surface.stop.corrected") }
        count("surface.stop.confirmed")
        let failed = progress.phase == .stopped && progress.stopReason != .you
        showResult(line, lifetime: failed ? 6 : Self.stoppedLineLifetime)
    }

    func endResult() {
        dropQuestion("surface.skill.lineEnded")
        result = nil
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
        result?.line = line
        drawResult(line)
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

    /// Draws a result line, with the question under it when one is asked. With a question the
    /// panel is taller, so it is placed again around the run's field: the grown panel may cover
    /// nothing the line did not (`SurfaceCoordinator.show`, the growth check).
    func drawResult(_ line: WorkLine) {
        var content = line.content
        content.question = question?.row
        lineText = line.text
        figure = content.figure
        guard !headless, !lineSuppressed else { return }
        if question != nil, let result, let anchor = result.anchor {
            showPanel(.line(content), text: line.text, placement: .atField(field: anchor.field, caret: anchor.caret, pid: result.target.pid, entering: false))
        } else {
            showPanel(.line(content), text: line.text, placement: .inPlace)
        }
    }

    /// The result line again, as the question now stands; its timer runs on.
    func redrawResult() {
        guard let result, resultTimer != nil else { return }
        drawResult(result.line)
    }

    // MARK: - Skills (B19)

    /// A keep or promote question from the helper. It is asked under the result of the run it is
    /// about (its toast, or a hand-off's line), at the caret where that run was taken, and nowhere
    /// else: offered with what the user just saw, never forced. One whose run's line is gone (typed
    /// through, closed, or another line took the panel) is not shown and not answered; the helper
    /// keeps it, and may ask again after a later run.
    public func skillOffer(_ offer: SkillOffer) {
        count("surface.skill.\(offer.kind.rawValue)")
        let snapshot = arbiter.snapshot()
        let toastUp = toastGrantID != nil && snapshot.toast?.id == toastGrantID
        let lineUp = resultStatusID != nil && snapshot.statusLine?.id == resultStatusID
        guard let result, result.taskID == offer.taskId, question == nil, resultTimer != nil, headless || !lineSuppressed, toastUp || lineUp else {
            count("surface.skill.notShown")
            return publish()
        }
        let accept = offer.actions.first?.label ?? "Yes"
        let line = ActionLine(
            offerKey: offer.id, app: "", endState: PopupSpec.Value(offer.says, ref: .derived(rule: "skillOffer", from: [])),
            actions: [PopupSpec.Action(id: "accept", label: accept, key: .tab)], answersToast: true
        )
        let held = Offer(
            text: "", source: .helper, kind: .action(line), target: result.target, fieldValue: "", caretUTF16: 0,
            createdAt: clock.now, maxAgeSeconds: Self.questionLifetime
        )
        guard let offerID = arbiter.publish(held) else {
            count("surface.skill.refused")
            return publish()
        }
        let now = clock.now
        asked = asked.filter { now.timeIntervalSince($0.value.at) < 2 * Self.questionLifetime }
        asked[offerID] = (offer, now)
        question = Question(offer: offer, offerID: offerID, row: WorkLines.question(offer))
        // ⌘Z keeps its run for as long as the question shows.
        if toastUp {
            toastGrantID = arbiter.showToast(UndoGrant.task(result.taskID, target: result.target, createdAt: now, lifetimeSeconds: Self.questionLifetime))
            toastInfo?.grantID = toastGrantID
        }
        count("surface.skill.shown")
        showResult(result.line, lifetime: Self.questionLifetime)
    }

    /// Esc closed this offer (the tap's `closeOffer`, before `offerChanged`): if it was a question,
    /// that is a no, whatever main has drawn since.
    public func offerClosed(_ offerID: UInt64) {
        guard asked[offerID] != nil else { return }
        answer(offerID, .decline)
    }

    /// Sends the answer to the question the tap took a key on. A no ends there; the line goes with
    /// Esc. A yes shows until the helper confirms it (`withdrawn`, taken), or `answerWait` passes.
    func answer(_ offerID: UInt64, _ choice: SkillAnswer.Answer) {
        guard let offer = asked.removeValue(forKey: offerID)?.offer else { return publish() }
        let sent = sendToHelper(.skillAnswer(SkillAnswer(id: offer.id, answer: choice, at: nowMs)))
        count(sent ? (choice == .accept ? "surface.skill.accepted" : "surface.skill.declined") : "surface.skill.unsent")
        guard var q = question, q.offerID == offerID, q.state == .asked else { return publish() }
        guard choice == .accept else {
            question = nil
            return publish()
        }
        q.state = sent ? .pending : .settled
        q.row = sent ? WorkLines.answering(offer) : WorkLines.answerUnsent
        question = q
        guard let result else { return publish() }
        guard sent else { return showResult(result.line, lifetime: Self.answerFailHold) }
        // The line stays while the helper is asked; the timer below decides when it gives up.
        showResult(result.line, lifetime: Self.answerWait + Self.answerHold)
        questionTimer?.cancel()
        questionTimer = clock.schedule(after: Self.answerWait, repeats: false) { [weak self] in
            guard let self, var q = self.question, q.offerID == offerID, q.state == .pending else { return }
            self.questionTimer = nil
            q.state = .settled
            q.row = WorkLines.answerUnconfirmed
            self.question = q
            self.count("surface.skill.unconfirmed")
            if let result = self.result { self.showResult(result.line, lifetime: Self.answerFailHold) }
        }
    }

    /// The question goes: unanswered, its offer leaves the arbiter (a Tab the tap already took on it
    /// is still answered, through `asked`); and the row leaves the line.
    func dropQuestion(_ counter: String) {
        questionTimer?.cancel()
        questionTimer = nil
        guard let q = question else { return }
        question = nil
        guard q.state == .asked else { return }
        arbiter.invalidate(offerID: q.offerID)
        count(counter)
    }

    /// An activity record (`activity`, or a row of `activityReply`): kept briefly, so a skill's run
    /// with no Tab can be drawn once it is known where it acts and which skill it is.
    public func activity(_ record: TaskRecord) {
        records[record.id] = record
        if records.count > 64 {
            // Finished records go first; the few that remain are recent enough to keep.
            for (id, r) in records where r.state != .running && r.state != .preparing && !unpromptedSeen.contains(id) {
                records[id] = nil
            }
        }
        guard unpromptedSeen.contains(record.id), work?.offerKey != record.id else { return }
        if startUnprompted(record.id) { publish() }
    }

    /// Draws a skill's run with no Tab at the caret, if that is where the user is: its app in front,
    /// a field focused, the caret uncovered. True when the line now shows. Tried until the record is
    /// known, then once: a run in an app behind is reported by the perch and the activity list only.
    @discardableResult
    func startUnprompted(_ taskID: String) -> Bool {
        guard unpromptedSeen.contains(taskID), !unpromptedDrawn.contains(taskID), let record = records[taskID], let app = record.app else { return false }
        // Work the user is watching (a Tab'd run, or another skill's) keeps the panel.
        guard work == nil else {
            count("surface.unprompted.workRunning")
            return false
        }
        unpromptedSeen.remove(taskID)
        let pid = Int32(truncatingIfNeeded: app.pid)
        guard world.allows(pid: pid) else {
            count("surface.unprompted.notAllowed")
            return false
        }
        let target: TargetIdentity
        var anchor: (field: CGRect, caret: CGRect)?
        if headless {
            // A headless host reads no field: the run is bound to its window, and nothing is drawn.
            target = TargetIdentity(pid: pid, bundleID: app.bundleId, windowID: record.windowId ?? "", elementID: "", elementRevision: "")
        } else {
            guard world.frontmostPID == pid, let field = world.focusedField(pid: pid), case .at(let caret) = world.caret(of: field),
                  gate(field.identity, anchors: [CGPoint(x: caret.midX, y: caret.midY)], requireFocus: false) == nil else {
                count("surface.unprompted.offCaret")
                return false
            }
            // The user's field must be in the window the run acts in, by title: another window of
            // the same app is somewhere else, and the line there would describe work it cannot see.
            if let acting = record.windowTitle, let here = field.window?.title, acting != here {
                count("surface.unprompted.otherWindow")
                return false
            }
            target = field.identity
            anchor = (field.frame ?? caret, caret)
        }
        // A run nobody asked for takes the panel, as a new offer would: it must not wait behind an
        // older line. What was shown there goes.
        if let shown { arbiter.invalidate(offerID: shown.offerID) }
        displacedShown = nil
        clear(exit: 0)
        endWork()
        endResult()
        lineSuppressed = false
        let now = clock.now
        let statusID = arbiter.showStatus(StatusLine(pid: pid, kind: .working(startedAt: now), offerKey: taskID, takesOverAtOnce: true))
        var started = Work(offerKey: taskID, app: app.name, pid: pid, statusID: statusID, startedAt: now, source: .helper, target: target, fill: nil)
        started.unprompted = true
        started.name = record.says
        started.figureLeft = true
        started.anchor = anchor.map { Anchor(field: $0.field, caret: $0.caret) }
        work = started
        unpromptedDrawn.insert(taskID)
        let line = WorkLines.onItsOwn(record.says, app: app.name)
        lineText = line.text
        figure = line.content.figure
        if let anchor {
            showPanel(.line(line.content), text: line.text, placement: .atField(field: anchor.field, caret: anchor.caret, pid: pid, entering: true))
            startWatch(.line, target: target, anchors: [CGPoint(x: anchor.caret.midX, y: anchor.caret.midY)], requireFocus: false, field: anchor.field)
        }
        workTimers.append(clock.schedule(after: 1, repeats: true) { [weak self] in self?.renderWorking() })
        emit(.workingChanged(true))
        count("surface.unprompted.shown")
        return true
    }
}
