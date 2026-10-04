import ApplicationServices
import CaretHostCore
import Darwin
import Foundation
import Security

/// Starts the helper and caret-screen from inside Caret.app, as helper/src/launch.ts does from a terminal (B23):
/// one 32-byte launch secret, made here and held only in this object's memory, written to each child's standard
/// input (`--auth-fd 0`) and closed. The reader accepts a helper only if it proves it holds that secret, and the
/// helper's page.sock key is derived from it, which is what the bridge relay proves (`pageKey`).
///
/// A child that exits on its own is started again with the same secret, within `RestartBudget`; past it both stop
/// and `stopped` says why, for the menu's "Caret stopped. Restart".
@MainActor
final class ServiceLauncher {
    enum Status: Equatable {
        case notStarted
        case running(pid: pid_t)
        /// Exited on its own; starting again after the restart delay.
        case restarting
        /// Not started yet, for the reason given.
        case waiting(String)
        case stopped
    }

    enum Which: String {
        case helper, reader
    }

    struct Service {
        let name: String
        var status: Status = .notStarted
        var budget = RestartBudget()
        /// Starts since the host launched, restarts included.
        var starts = 0
        var lastExit: String?
    }

    private let programs: CaretServices.Programs
    private let home: CaretHome
    private let log: (String) -> Void
    /// The launch secret. Never written to argv, the environment, a file or defaults; only to each child's stdin.
    private let secret: Data
    private(set) var helper = Service(name: "helper")
    private(set) var reader = Service(name: "reader")
    /// Why both services stopped, until the user restarts them.
    private(set) var stopped: String?
    private var stopping = false
    /// The stop that follows a crash past the budget; a Restart waits for it, so it cannot stop the new children.
    private var stopTask: Task<Void, Never>?
    /// Bumped by every start and stop. A delayed restart from before it does nothing, so a stop or a Restart cannot
    /// leave a stale timer that starts a second reader later (H4 review).
    private var generation = 0
    /// A Restart is waiting for the stop to finish; a second one is ignored.
    private var restartPending = false
    private var sources: [pid_t: DispatchSourceProcess] = [:]

    private func update(_ which: Which, _ body: (inout Service) -> Void) {
        switch which {
        case .helper: body(&helper)
        case .reader: body(&reader)
        }
    }
    private var accessibilityPoll: Timer?
    /// Called on main whenever a service's status changes.
    var onChange: (() -> Void)?

    /// Throws only when the system has no randomness to give, which ends the launch.
    init(programs: CaretServices.Programs, home: CaretHome, log: @escaping (String) -> Void) throws {
        self.programs = programs
        self.home = home
        self.log = log
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw LaunchError("no random bytes for the launch secret (SecRandomCopyBytes failed)")
        }
        secret = Data(bytes)
    }

    struct LaunchError: Error, CustomStringConvertible {
        let description: String
        init(_ d: String) { description = d }
    }

    /// The page key the helper derives from the secret (`HMAC(secret, "caret-page-key")`), for the bridge relay.
    func pageKey(_ derive: (Data) -> Data) -> Data { derive(secret) }

    /// The helper's socket the host connects to.
    var helperSocket: String { home.screenSocket }

    func start() {
        generation += 1
        stopping = false
        stopped = nil
        do {
            try prepareHome()
        } catch {
            return stopAll(because: "Caret could not prepare \(home.root): \(error)")
        }
        for pid in Self.stopStale(file: home.childrenFile, log: log) {
            log("stopped process \(pid), which an earlier Caret in \(home.root) left running")
        }
        startHelper()
        startReaderWhenTrusted()
    }

    /// The user chose Restart after a stop: fresh budgets, the same secret.
    func restart() {
        guard stopped != nil, !restartPending else { return }
        restartPending = true
        helper.budget.reset()
        reader.budget.reset()
        log("restarting the helper and the reader at the user's request")
        let pending = stopTask
        Task { [weak self] in
            await pending?.value
            guard let self else { return }
            self.stopTask = nil
            self.restartPending = false
            self.start()
        }
    }

    /// Stops both children: SIGTERM, then SIGKILL after `grace` seconds. Returns once both are reaped.
    func stop(grace: TimeInterval = 3) async {
        stopping = true
        generation += 1
        accessibilityPoll?.invalidate()
        accessibilityPoll = nil
        let pids = [helper.status, reader.status].compactMap { s -> pid_t? in if case .running(let p) = s { return p } else { return nil } }
        for pid in pids { kill(pid, SIGTERM) }
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline, pids.contains(where: { sources[$0] != nil }) {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        for pid in pids where sources[pid] != nil {
            log("process \(pid) did not stop within \(Int(grace)) s of SIGTERM; killing it")
            kill(pid, SIGKILL)
        }
        while pids.contains(where: { sources[$0] != nil }) {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        helper.status = .stopped
        reader.status = .stopped
        recordChildren()
    }

    // MARK: - Starting

    /// The socket directory must be the user's own and closed to others before the reader will connect (B23); the
    /// helper also chmods it, this only makes sure it exists before either child starts.
    private func prepareHome() throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: home.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.createDirectory(atPath: home.socketsDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: home.socketsDirectory)
    }

    private func startHelper() {
        guard !stopping else { return }
        var args = [programs.helperEntry, "--auth-fd", "0", "--socket", home.screenSocket, "--page-socket", home.pageSocket, "--data-dir", home.dataDirectory]
        let env = Self.childEnvironment(ProcessInfo.processInfo.environment)
        if !Self.hasJevKey(env) {
            // Without a key the helper refuses to start (fill/jev.ts loadJevKey), and every restart would fail the
            // same way. Provisional (H4): run it without Jev and say so, until key setup is part of onboarding.
            args.append("--no-jev")
            log("the helper runs without Jev: no TYPESAFE_API_KEY or CARET_ENV_FILE in Caret's environment")
        }
        spawn(.helper, path: programs.node, args: args, env: env)
    }

    /// caret-screen exits at once without the Accessibility grant (caret-screen main.swift), which would spend the
    /// restart budget before onboarding asks for it. It runs as Caret's child, so Caret's own grant is the one the
    /// system checks; until Caret has it, wait and look again every 2 s.
    private func startReaderWhenTrusted() {
        guard !stopping else { return }
        if AXIsProcessTrusted() {
            accessibilityPoll?.invalidate()
            accessibilityPoll = nil
            startReader()
            return
        }
        update(.reader) { $0.status = .waiting("Caret does not have Accessibility yet") }
        onChange?()
        guard accessibilityPoll == nil else { return }
        log("the reader waits for Caret's Accessibility grant")
        accessibilityPoll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, AXIsProcessTrusted() else { return }
                self.startReaderWhenTrusted()
            }
        }
    }

    private func startReader() {
        let args = ["--auth-fd", "0", "--socket", home.screenSocket, "--deny-list", home.denyList]
        spawn(.reader, path: programs.reader, args: args, env: Self.childEnvironment(ProcessInfo.processInfo.environment))
    }

    /// The children's environment, built rather than inherited: nothing like NODE_OPTIONS or DYLD_* reaches them.
    /// The Jev key passes through by the two names the helper reads (fill/jev.ts).
    static func childEnvironment(_ host: [String: String]) -> [String: String] {
        var env = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "TYPESAFE_API_KEY", "CARET_ENV_FILE"] {
            if let v = host[key], !v.isEmpty { env[key] = v }
        }
        return env
    }

    static func hasJevKey(_ env: [String: String]) -> Bool {
        env["TYPESAFE_API_KEY"] != nil || env["CARET_ENV_FILE"] != nil
    }

    private func spawn(_ which: Which, path: String, args: [String], env: [String: String]) {
        switch Self.spawnWithSecret(path: path, args: args, env: env, secret: secret) {
        case .failure(let error):
            log("could not start the \(which.rawValue) (\(path)): \(error)")
            exited(which, how: "could not start: \(error)")
        case .success(let pid):
            update(which) {
                $0.status = .running(pid: pid)
                $0.starts += 1
            }
            log("started the \(which.rawValue), process \(pid)")
            watch(pid, which)
            recordChildren()
            onChange?()
        }
    }

    /// posix_spawn with every descriptor closed but 0, 1 and 2 (POSIX_SPAWN_CLOEXEC_DEFAULT), so no socket or the
    /// XPC listener leaks into a child; stdin is a pipe that gets the secret and is closed; stdout and stderr are
    /// Caret's. Signals go back to their defaults: Caret ignores SIGTERM and SIGINT for its own shutdown, and an
    /// ignored signal survives exec, so a child would never stop on SIGTERM.
    static func spawnWithSecret(path: String, args: [String], env: [String: String], secret: Data) -> Result<pid_t, LaunchError> {
        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else { return .failure(LaunchError("pipe: \(String(cString: strerror(errno)))")) }
        let (readEnd, writeEnd) = (fds[0], fds[1])
        // Only the child's copy of the read end is wanted; the write end must not reach any child.
        _ = fcntl(writeEnd, F_SETFD, FD_CLOEXEC)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, readEnd, 0)
        posix_spawn_file_actions_addinherit_np(&actions, 1)
        posix_spawn_file_actions_addinherit_np(&actions, 2)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        var all = sigset_t()
        sigfillset(&all)
        var none = sigset_t()
        sigemptyset(&none)
        posix_spawnattr_setsigdefault(&attr, &all)
        posix_spawnattr_setsigmask(&attr, &none)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))

        let argv = ([path] + args).map { strdup($0) } + [nil]
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for p in argv { free(p) }
            for p in envp { free(p) }
        }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, path, &actions, &attr, argv, envp)
        close(readEnd)
        guard rc == 0 else {
            close(writeEnd)
            return .failure(LaunchError("posix_spawn: \(String(cString: strerror(rc)))"))
        }
        // 32 bytes always fit in an empty pipe's buffer, so this write never waits on the child.
        let wrote = secret.withUnsafeBytes { write(writeEnd, $0.baseAddress, $0.count) }
        close(writeEnd)
        if wrote != secret.count {
            kill(pid, SIGKILL)
            var status: Int32 = 0
            waitpid(pid, &status, 0)
            return .failure(LaunchError("could not hand the launch secret to process \(pid)"))
        }
        return .success(pid)
    }

    // MARK: - Exits

    private func watch(_ pid: pid_t, _ which: Which) {
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        sources[pid] = source
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.reap(pid, which) }
        }
        source.resume()
        // A child that exited before the source was armed: reap it now.
        reap(pid, which)
    }

    private func reap(_ pid: pid_t, _ which: Which) {
        var status: Int32 = 0
        let r = waitpid(pid, &status, WNOHANG)
        guard r == pid || (r < 0 && errno == ECHILD) else { return }
        guard let source = sources.removeValue(forKey: pid) else { return }
        source.cancel()
        let how = r == pid ? Self.describe(status) : "gone"
        recordChildren()
        guard !stopping else { return }
        exited(which, how: how)
    }

    /// `waitpid`'s status as words; WIFEXITED and friends are macros Swift cannot see.
    static func describe(_ status: Int32) -> String {
        let signal = status & 0x7f
        if signal == 0 { return "exit \((status >> 8) & 0xff)" }
        return "signal \(signal)"
    }

    private func exited(_ which: Which, how: String) {
        let now = ProcessInfo.processInfo.systemUptime
        var decision = RestartBudget.Decision.stop(exits: 0)
        update(which) {
            $0.lastExit = how
            decision = $0.budget.exited(at: now)
        }
        let name = which.rawValue
        switch decision {
        case .restart(let delay):
            log("the \(name) exited (\(how)); starting it again with the same secret")
            update(which) { $0.status = .restarting }
            onChange?()
            let generation = self.generation
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.generation == generation, !self.stopping, self.stopped == nil else { return }
                    switch which {
                    case .helper: self.startHelper()
                    case .reader: self.startReaderWhenTrusted()
                    }
                }
            }
        case .stop(let exits):
            stopAll(because: "the \(name) exited \(exits) times within \(Int(RestartBudget.defaultWindow)) s (last: \(how))")
        }
    }

    private func stopAll(because reason: String) {
        log("stopping the helper and the reader: \(reason)")
        stopped = reason
        stopTask = Task { [weak self] in
            await self?.stop()
            // stop() set `stopping`; a Restart clears it.
            self?.onChange?()
        }
        onChange?()
    }

    // MARK: - Children a killed Caret left

    /// A child as the next Caret can recognize it: the same pid alone could be another process by then.
    struct ChildRecord: Codable, Equatable {
        let pid: Int32
        let startMicros: UInt64
        let path: String
    }

    /// The running, non-zombie process `pid`, or nil.
    static func childRecord(_ pid: pid_t) -> ChildRecord? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_status != UInt32(SZOMB) else { return nil }
        var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
        let path = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return ChildRecord(pid: pid, startMicros: UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec), path: path)
    }

    /// Writes this home's running children, so a Caret that starts after this one was killed can stop them (a host
    /// killed outside launchd leaves its helper and reader running; under launchd the job's process group goes too).
    private func recordChildren() {
        var records: [ChildRecord] = []
        for s in [helper, reader] {
            if case .running(let pid) = s.status, let r = Self.childRecord(pid) { records.append(r) }
        }
        guard let data = try? JSONEncoder().encode(records) else { return }
        FileManager.default.createFile(atPath: home.childrenFile, contents: data, attributes: [.posixPermissions: 0o600])
    }

    /// Stops each recorded child that still runs as the same process (pid, start time and executable): SIGTERM, then
    /// SIGKILL after 2 s. Returns the pids it stopped. Anything else is left alone.
    static func stopStale(file: String, log: (String) -> Void) -> [pid_t] {
        guard let data = FileManager.default.contents(atPath: file),
              let records = try? JSONDecoder().decode([ChildRecord].self, from: data) else { return [] }
        var stopped: [pid_t] = []
        for r in records where childRecord(r.pid) == r {
            kill(r.pid, SIGTERM)
            let deadline = Date().addingTimeInterval(2)
            while Date() < deadline, childRecord(r.pid) == r { usleep(20_000) }
            if childRecord(r.pid) == r {
                log("process \(r.pid) did not stop within 2 s of SIGTERM; killing it")
                kill(r.pid, SIGKILL)
            }
            stopped.append(r.pid)
        }
        return stopped
    }

    // MARK: - Report

    func report() -> [String: Any] {
        func entry(_ s: Service) -> [String: Any] {
            var e: [String: Any] = ["starts": s.starts]
            switch s.status {
            case .notStarted: e["state"] = "notStarted"
            case .running(let pid): e["state"] = "running"; e["pid"] = Int(pid)
            case .restarting: e["state"] = "restarting"
            case .waiting(let why): e["state"] = "waiting"; e["why"] = why
            case .stopped: e["state"] = "stopped"
            }
            if let last = s.lastExit { e["lastExit"] = last }
            return e
        }
        var r: [String: Any] = ["helper": entry(helper), "reader": entry(reader)]
        if let stopped { r["stopped"] = stopped }
        return r
    }
}
