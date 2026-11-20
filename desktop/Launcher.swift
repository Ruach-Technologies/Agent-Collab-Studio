import SwiftUI
import AppKit

// MARK: - Palette

private enum Palette {
    static let background = Color(red: 11/255, green: 14/255, blue: 20/255)
    static let panel = Color(red: 19/255, green: 24/255, blue: 36/255)
    static let raised = Color(red: 26/255, green: 32/255, blue: 48/255)
    static let mint = Color(red: 126/255, green: 226/255, blue: 184/255)
    static let blue = Color(red: 130/255, green: 170/255, blue: 255/255)
    static let lilac = Color(red: 199/255, green: 146/255, blue: 234/255)
    static let amber = Color(red: 255/255, green: 196/255, blue: 110/255)
    static let red = Color(red: 1, green: 0.48, blue: 0.58)
    static let muted = Color(red: 125/255, green: 138/255, blue: 160/255)
}

private let studioAddress = "http://127.0.0.1:8791/"

// MARK: - Settings

private struct Settings: Codable, Equatable {
    static let defaultSandboxImage = "agent-collab-sandbox:local"
    static var defaultOwnerName: String {
        let first = NSFullUserName().split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? NSUserName() : first
    }

    var repository = ""
    var nodePath = ""
    var npmPath = ""
    var ngrokPath = ""
    var sandboxImage = Settings.defaultSandboxImage
    var openConsole = true
    var tunnelOnLaunch = false
    var ownerName = Settings.defaultOwnerName

    init() {}

    /// Tolerant decoding: older launcher.json / bootstrap.json files may lack newer keys.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let fallback = Settings()
        repository = c.soft(.repository) ?? fallback.repository
        nodePath = c.soft(.nodePath) ?? fallback.nodePath
        npmPath = c.soft(.npmPath) ?? fallback.npmPath
        ngrokPath = c.soft(.ngrokPath) ?? fallback.ngrokPath
        sandboxImage = c.soft(.sandboxImage) ?? fallback.sandboxImage
        openConsole = c.soft(.openConsole) ?? fallback.openConsole
        tunnelOnLaunch = c.soft(.tunnelOnLaunch) ?? fallback.tunnelOnLaunch
        ownerName = c.soft(.ownerName) ?? fallback.ownerName
    }
}

// MARK: - Bridge contract

private extension KeyedDecodingContainer {
    /// A missing or malformed field yields nil instead of failing the whole reply.
    func soft<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
    /// Drops only the malformed elements of a list.
    func softList<T: Decodable>(_ key: Key) -> [T]? {
        guard let items = (try? decodeIfPresent([Lossy<T>].self, forKey: key)) ?? nil else { return nil }
        return items.compactMap { $0.value }
    }
}

private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

private struct Service: Decodable { var state: String?; var detail: String? }
private struct GateStatus: Decodable { var state: String? }
private struct DatabaseStatus: Decodable { var state: String?; var version: Int?; var expected: Int? }
private struct AlertCounts: Decodable { var open: Int?; var high: Int? }

private struct Snapshot: Decodable {
    var hub: Service?
    var tunnel: Service?
    var publicUrl: String?
    var dockerAvailable: Bool?
    var gate: GateStatus?
    var database: DatabaseStatus?
    var alerts: AlertCounts?

    private enum CodingKeys: String, CodingKey { case hub, tunnel, publicUrl, dockerAvailable, gate, database, alerts }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hub = c.soft(.hub); tunnel = c.soft(.tunnel); publicUrl = c.soft(.publicUrl)
        dockerAvailable = c.soft(.dockerAvailable); gate = c.soft(.gate)
        database = c.soft(.database); alerts = c.soft(.alerts)
    }
}

private struct WorkspaceSummary: Decodable, Identifiable {
    let id: String
    var name: String?
    var created_at: String?
    var people: Int?
    var rooms: Int?
}

private struct SidekickInfo: Decodable {
    var id: String?
    var name: String?
    var provider: String?
    var signed_in: Bool?
    var asleep: Bool?
}

private struct Person: Decodable, Identifiable {
    let id: String
    var workspace_id: String?
    var name: String?
    var role: String?
    var kind: String?
    var created_at: String?
    var last_seen_at: String?
    var active: Bool?
    var session_until: String?
    var passkeys: Int?
    var sidekick: SidekickInfo?
    var owner_id: String?
    var provider: String?
    var signed_in: Bool?

    var displayName: String { (name?.isEmpty == false ? name : nil) ?? "Unnamed" }
    var group: String {
        if let kind { return kind }
        return role == "agent" ? "agent" : "staff"
    }
}

private struct Room: Decodable, Identifiable {
    let id: String
    var workspace_id: String?
    var name: String?
    var created_at: String?
    var members: Int?
    var sandbox: String?
    var displayName: String { (name?.isEmpty == false ? name : nil) ?? "Untitled room" }
}

private struct Invite: Decodable, Identifiable {
    let id: String
    var workspace_id: String?
    var room_id: String?
    var label: String?
    var created_at: String?
    var expires_at: String?
    var state: String?
}

/// A GitHub organization with a saved token in this workspace. The token itself never leaves the hub's data folder.
private struct GithubToken: Decodable, Identifiable {
    var workspace_id: String?
    var owner: String
    var added_at: String?
    var id: String { owner.lowercased() }
}

private struct NamedRef: Decodable { var id: String?; var name: String? }
private struct InviteRef: Decodable { var id: String?; var expires_at: String? }

private struct ReplyData: Decodable {
    var workspaces: [WorkspaceSummary]?
    var people: [Person]?
    var rooms: [Room]?
    var invites: [Invite]?
    var github: [GithubToken]?
    var owner: String?
    var replaced: Bool?
    var removed: Bool?
    var workspace: NamedRef?
    var agent: NamedRef?
    var invite: InviteRef?
    var token: String?
    var url: String?
    var expires_at: String?
    var name: String?
    var backup: String?
    var revoked: Int?
    var ended: Int?

    init() {}
    private enum CodingKeys: String, CodingKey {
        case workspaces, people, rooms, invites, github, owner, replaced, removed, workspace, agent, invite, token, url, expires_at, name, backup, revoked, ended
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaces = c.softList(.workspaces); people = c.softList(.people)
        rooms = c.softList(.rooms); invites = c.softList(.invites); github = c.softList(.github)
        owner = c.soft(.owner); replaced = c.soft(.replaced); removed = c.soft(.removed)
        workspace = c.soft(.workspace); agent = c.soft(.agent); invite = c.soft(.invite)
        token = c.soft(.token); url = c.soft(.url); expires_at = c.soft(.expires_at); name = c.soft(.name)
        backup = c.soft(.backup); revoked = c.soft(.revoked); ended = c.soft(.ended)
    }
}

private struct BridgeReply: Decodable {
    var ok: Bool
    var message: String?
    var snapshot: Snapshot?
    var data: ReplyData?

    private enum CodingKeys: String, CodingKey { case ok, message, snapshot, data }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.soft(.ok) ?? false
        message = c.soft(.message); snapshot = c.soft(.snapshot); data = c.soft(.data)
    }
}

private struct Request: Encodable {
    var command: String
    var settings: Settings
    var workspace: [String: String]? = nil
    var confirm: String? = nil
}

private struct LocalFailure: LocalizedError {
    var errorDescription: String?
    init(_ text: String) { errorDescription = text }
}

private func runBridge(_ request: Request) throws -> BridgeReply {
    guard request.settings.nodePath.hasPrefix("/"),
          FileManager.default.isExecutableFile(atPath: request.settings.nodePath),
          let bridge = Bundle.main.url(forResource: "controller", withExtension: "mjs") else {
        throw LocalFailure("Select an installed Node.js 22+ executable in Settings.")
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: request.settings.nodePath)
    process.arguments = [bridge.path]
    let output = Pipe()
    let input = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    process.environment = ["HOME": home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
    try process.run()
    let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 240, execute: timeout)
    defer { timeout.cancel() }
    do {
        try input.fileHandleForWriting.write(contentsOf: JSONEncoder().encode(request))
        try input.fileHandleForWriting.close()
    } catch {
        if process.isRunning { process.terminate() }
        throw LocalFailure("Could not send a local operation to the controller.")
    }
    var data = Data()
    while true {
        let chunk = output.fileHandleForReading.readData(ofLength: 16 * 1024)
        if chunk.isEmpty { break }
        guard data.count + chunk.count <= 1024 * 1024 else {
            if process.isRunning { process.terminate() }
            try? output.fileHandleForReading.close()
            throw LocalFailure("The local controller response exceeded its size limit.")
        }
        data.append(chunk)
    }
    process.waitUntilExit()
    guard data.count <= 1024 * 1024,
          let reply = try? JSONDecoder().decode(BridgeReply.self, from: data) else {
        throw LocalFailure("The local controller did not return a valid response. Check Node.js and the repository path.")
    }
    return reply
}

// MARK: - Helpers

/// Secrets copied to the clipboard are cleared after 60 seconds if the clipboard still holds them.
private enum SecretClipboard {
    static var guardedChange: Int?
    private static let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")

    static func copy(_ value: String) {
        let board = NSPasteboard.general
        board.declareTypes([.string, concealed], owner: nil)
        board.setString(value, forType: .string)
        board.setString("", forType: concealed)
        let change = board.changeCount
        guardedChange = change
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            let board = NSPasteboard.general
            if board.changeCount == change, board.string(forType: .string) == value { board.clearContents() }
            if guardedChange == change { guardedChange = nil }
        }
    }

    static func clearIfStillHeld() {
        if let change = guardedChange, NSPasteboard.general.changeCount == change {
            NSPasteboard.general.clearContents()
        }
        guardedChange = nil
    }
}

private enum Clock {
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static let sqlite: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()
    private static let timeOnly: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short; return f
    }()
    private static let dayAndTime: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; return f
    }()
    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .full; return f
    }()

    static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return isoFractional.date(from: text) ?? iso.date(from: text) ?? sqlite.date(from: text)
    }
    /// "5:01 PM" today, otherwise "Nov 20, 2026 at 5:01 PM".
    static func moment(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? timeOnly.string(from: date) : dayAndTime.string(from: date)
    }
    static func relative(_ date: Date) -> String {
        if abs(date.timeIntervalSinceNow) < 60 { return "just now" }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}

private func plural(_ count: Int, _ one: String, _ many: String) -> String {
    "\(count) \(count == 1 ? one : many)"
}

private func providerName(_ value: String?) -> String {
    switch value {
    case "claude": return "Claude"
    case "codex": return "ChatGPT"
    case let other?: return other.capitalized
    case nil: return "Unknown helper"
    }
}

private func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

// MARK: - Presentation state

private struct Reveal {
    enum Kind { case token, link }
    var kind: Kind
    var title: String
    var detail: String?
    var secret: String
}

private enum ActiveSheet: Identifiable {
    case settings, newWorkspace, freshStart
    case addStaff(WorkspaceSummary)
    case newRoom(WorkspaceSummary)
    case addGithubToken(WorkspaceSummary, String?)
    case rename(WorkspaceSummary)
    case deleteWorkspace(WorkspaceSummary)
    case invite(Room)
    case reveal(Reveal)

    var id: String {
        switch self {
        case .settings: return "settings"
        case .newWorkspace: return "new-workspace"
        case .addStaff(let w): return "add-staff-\(w.id)"
        case .newRoom(let w): return "new-room-\(w.id)"
        case .addGithubToken(let w, let owner): return "github-\(w.id)-\(owner ?? "")"
        case .freshStart: return "fresh-start"
        case .rename(let w): return "rename-\(w.id)"
        case .deleteWorkspace(let w): return "delete-\(w.id)"
        case .invite(let r): return "invite-\(r.id)"
        case .reveal: return "reveal"
        }
    }
}

private struct Confirmation: Identifiable {
    let id = UUID()
    var title: String
    var message: String
    var button: String
    var destructive: Bool
    var action: @MainActor () async -> Void
}

// MARK: - Model

@MainActor
private final class StudioModel: ObservableObject {
    enum Mode { case user, follow, background }

    @Published private(set) var settings: Settings
    @Published var snapshot: Snapshot?
    @Published var busy = false
    @Published var message = "Opening this window doesn't start anything. Press Launch when you're ready."
    @Published var failed = false
    @Published var workspaces: [WorkspaceSummary] = []
    @Published var selectedWorkspace: String? {
        didSet { if let id = selectedWorkspace { UserDefaults.standard.set(id, forKey: Self.lastWorkspaceKey) } }
    }
    private static let lastWorkspaceKey = "lastWorkspace"
    @Published var people: [Person] = []
    @Published var rooms: [Room] = []
    @Published var invites: [Invite] = []
    @Published var githubTokens: [GithubToken] = []
    @Published var listError: String?
    @Published var backupPath: String?
    @Published var activeSheet: ActiveSheet?
    @Published var confirmation: Confirmation?

    private let preferences: URL
    /// Serialises bridge calls. Background polls hold only this, so the controls
    /// are not disabled and re-enabled (a visible flicker) every few seconds.
    private var working = false
    private var failureFromPoll = false

    init() {
        let support = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Agent Collab Hub", isDirectory: true)
        preferences = support.appendingPathComponent("launcher.json")
        var initial = Settings()
        if let bootstrapURL = Bundle.main.url(forResource: "bootstrap", withExtension: "json"),
           let data = try? Data(contentsOf: bootstrapURL),
           let bootstrap = try? JSONDecoder().decode(Settings.self, from: data) { initial = bootstrap }
        if let data = try? Data(contentsOf: preferences),
           let stored = try? JSONDecoder().decode(Settings.self, from: data) { initial = stored }
        // The previous default image no longer exists for Collab Studio.
        if initial.sandboxImage == "openclaw-sandbox:bookworm-slim" || trimmed(initial.sandboxImage).isEmpty {
            initial.sandboxImage = Settings.defaultSandboxImage
        }
        if trimmed(initial.ownerName).isEmpty { initial.ownerName = Settings.defaultOwnerName }
        settings = initial
    }

    // Derived state

    var hubRunning: Bool { snapshot?.hub?.state == "running" }
    var tunnelRunning: Bool { snapshot?.tunnel?.state == "running" }
    var databaseState: String? { snapshot?.database?.state }
    var canManage: Bool { databaseState == "current" }
    var selectedSummary: WorkspaceSummary? { workspaces.first { $0.id == selectedWorkspace } }
    var publicURL: URL? {
        guard tunnelRunning, let value = snapshot?.publicUrl,
              let url = URL(string: value), url.scheme == "https", url.user == nil,
              url.password == nil, url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    // Serialisation

    private func begin(_ mode: Mode) async -> Bool {
        switch mode {
        case .background:
            if working { return false }
        case .follow:
            while working { try? await Task.sleep(nanoseconds: 50_000_000) }
        case .user:
            if busy { return false }
            busy = true
            while working { try? await Task.sleep(nanoseconds: 50_000_000) }
        }
        working = true
        return true
    }

    private func finish(_ mode: Mode) {
        working = false
        if mode == .user { busy = false }
    }

    private func send(_ request: Request) async throws -> BridgeReply {
        try await Task.detached(priority: .userInitiated) { try runBridge(request) }.value
    }

    func note(_ text: String, failed isFailure: Bool = false) {
        message = text
        failed = isFailure
        failureFromPoll = false
    }

    // Service commands

    @discardableResult
    func operate(_ command: String, confirm: String? = nil, using override: Settings? = nil,
                 mode: Mode = .user) async -> BridgeReply? {
        guard await begin(mode) else {
            if mode == .user { note("Another operation is still running. Try again in a moment.", failed: true) }
            return nil
        }
        let before = databaseState
        var result: BridgeReply?
        do {
            let reply = try await send(Request(command: command, settings: override ?? settings, confirm: confirm))
            if let current = reply.snapshot { snapshot = current } else if command == "status" { snapshot = nil }
            if reply.ok {
                result = reply
                if mode == .user {
                    note(reply.message ?? "Done.")
                } else if failed && failureFromPoll {
                    message = reply.message ?? "Status refreshed."; failed = false; failureFromPoll = false
                }
            } else if mode == .user || !failed || failureFromPoll {
                message = reply.message ?? "The operation did not complete."
                failed = true
                failureFromPoll = mode != .user
            }
        } catch {
            if command == "status" { snapshot = nil }
            if mode == .user || !failed || failureFromPoll {
                message = error.localizedDescription
                failed = true
                failureFromPoll = mode != .user
            }
        }
        finish(mode)
        databaseMayHaveChanged(from: before)
        return result
    }

    private func databaseMayHaveChanged(from before: String?) {
        let now = databaseState
        guard now != before else { return }
        if now == "current" {
            Task { await refreshList(.follow) }
        } else {
            workspaces = []; selectedWorkspace = nil; listError = nil; clearDetail()
        }
    }

    func refreshStatus(_ mode: Mode = .background) async { await operate("status", mode: mode) }

    func launch() async {
        guard await operate("launch") != nil else { return }
        if settings.openConsole, hubRunning { openStudio() }
    }

    func freshStart() async -> Bool {
        guard let reply = await operate("fresh-start", confirm: "START FRESH") else { return false }
        backupPath = reply.data?.backup
        workspaces = []; selectedWorkspace = nil; clearDetail()
        activeSheet = nil
        if canManage { await refreshList(.follow) }
        return true
    }

    func upgrade() async {
        guard let reply = await operate("upgrade", confirm: "UPGRADE") else { return }
        backupPath = reply.data?.backup
        if canManage { await refreshList(.follow) }
    }

    func validateAndSave(_ draft: Settings) async -> Bool {
        guard await operate("validate", using: draft) != nil else { return false }
        settings = draft
        do {
            try save()
        } catch {
            note("Settings were checked but could not be saved: \(error.localizedDescription)", failed: true)
            return false
        }
        note("Settings saved and checked.")
        activeSheet = nil
        Task { await refreshStatus(.follow) }
        return true
    }

    private func save() throws {
        try FileManager.default.createDirectory(at: preferences.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(settings)
        try data.write(to: preferences, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: preferences.path)
    }

    // Workspace commands

    func manage(_ action: String, _ fields: [String: String] = [:], mode: Mode = .user) async -> ReplyData? {
        guard canManage else {
            if mode == .user { note("Workspaces can be managed once the hub's data is up to date.", failed: true) }
            return nil
        }
        guard await begin(mode) else {
            if mode == .user { note("Another operation is still running. Try again in a moment.", failed: true) }
            return nil
        }
        var payload = fields
        payload["action"] = action
        var outcome: Result<ReplyData, Error>
        do {
            let reply = try await send(Request(command: "workspace", settings: settings, workspace: payload))
            if let current = reply.snapshot { snapshot = current }
            outcome = reply.ok ? .success(reply.data ?? ReplyData())
                : .failure(LocalFailure(reply.message ?? "That didn't work. Please try again."))
        } catch {
            outcome = .failure(error)
        }
        finish(mode)
        switch outcome {
        case .success(let data):
            return data
        case .failure(let error):
            if mode == .user { note(error.localizedDescription, failed: true) }
            if action == "list" { listError = error.localizedDescription }
            return nil
        }
    }

    /// Runs a user action, reports success and then quietly reloads the workspace.
    func mutate(_ action: String, _ fields: [String: String], done: (ReplyData) -> String) async -> ReplyData? {
        guard let data = await manage(action, fields) else { return nil }
        note(done(data))
        await refreshList(.follow)
        return data
    }

    func refreshList(_ mode: Mode) async {
        guard canManage else { return }
        let target = selectedWorkspace
        guard let data = await manage("list", target.map { ["workspaceId": $0] } ?? [:], mode: mode) else { return }
        listError = nil
        if let list = data.workspaces {
            workspaces = list
            if selectedWorkspace == nil || !list.contains(where: { $0.id == selectedWorkspace }) {
                // Reopen where the operator left off, not on whichever workspace sorts first.
                let last = UserDefaults.standard.string(forKey: Self.lastWorkspaceKey)
                selectedWorkspace = list.first(where: { $0.id == last })?.id ?? list.first?.id
                clearDetail()
            }
        }
        guard let current = selectedWorkspace else { clearDetail(); return }
        if target == current || target == nil {
            people = (data.people ?? []).filter { $0.workspace_id == nil || $0.workspace_id == current }
            rooms = (data.rooms ?? []).filter { $0.workspace_id == nil || $0.workspace_id == current }
            invites = (data.invites ?? []).filter { $0.workspace_id == nil || $0.workspace_id == current }
            githubTokens = (data.github ?? []).filter { $0.workspace_id == current }
        }
        // The selection changed while this call ran, or was chosen just now: load it.
        if target != current { Task { await refreshList(.follow) } }
    }

    func select(_ id: String) {
        guard id != selectedWorkspace else { return }
        selectedWorkspace = id
        clearDetail()
        Task { await refreshList(.follow) }
    }

    private func clearDetail() { people = []; rooms = []; invites = []; githubTokens = [] }

    func reveal(_ reveal: Reveal) {
        if activeSheet == nil {
            activeSheet = .reveal(reveal)
        } else {
            activeSheet = nil
            Task {
                try? await Task.sleep(nanoseconds: 400_000_000)
                activeSheet = .reveal(reveal)
            }
        }
    }

    func createWorkspace(name: String) async -> Bool {
        guard let data = await mutate("create-workspace", ["name": name], done: {
            "Workspace “\($0.workspace?.name ?? name)” created."
        }) else { return false }
        if let id = data.workspace?.id { select(id) }
        if let token = data.token {
            let owner = data.agent?.name ?? settings.ownerName
            reveal(Reveal(kind: .token, title: "Your staff token",
                          detail: "For \(owner) in “\(data.workspace?.name ?? name)”. Use it to sign in to the Studio.",
                          secret: token))
        } else {
            activeSheet = nil
        }
        return true
    }

    func renameWorkspace(_ id: String, to name: String) async -> Bool {
        guard await mutate("rename-workspace", ["workspaceId": id, "name": name], done: { _ in
            "Workspace renamed to “\(name)”."
        }) != nil else { return false }
        activeSheet = nil
        return true
    }

    func deleteWorkspace(_ id: String, confirmName: String) async -> Bool {
        guard await mutate("delete-workspace", ["workspaceId": id, "confirmName": confirmName], done: { data in
            "Workspace “\(confirmName)” deleted." + (data.backup.map { " Backup: \($0)" } ?? "")
        }) != nil else { return false }
        activeSheet = nil
        return true
    }

    /// The workspace is the one the sheet was opened for, never whatever is selected at submit time.
    func addStaff(to workspace: WorkspaceSummary, name: String, role: String) async -> Bool {
        let place = workspace.name ?? "the workspace"
        guard let data = await mutate("add-staff", ["workspaceId": workspace.id, "name": name, "role": role], done: { _ in
                  "\(name) was added to the staff of “\(place)”."
              }) else { return false }
        if let token = data.token {
            reveal(Reveal(kind: .token, title: "Staff token for \(data.agent?.name ?? name)",
                          detail: "\(data.agent?.name ?? name) uses this token to sign in to the Studio for “\(place)”.", secret: token))
        } else {
            activeSheet = nil
        }
        return true
    }

    func newToken(for person: Person) async {
        guard let workspace = person.workspace_id ?? selectedWorkspace,
              let data = await mutate("issue-token", ["workspaceId": workspace, "agentId": person.id], done: { _ in
                  "New token made for \(person.displayName). Earlier tokens keep working until you revoke them."
              }), let token = data.token else { return }
        reveal(Reveal(kind: .token, title: "New token for \(data.agent?.name ?? person.displayName)",
                      detail: "Earlier tokens keep working until you revoke this person.", secret: token))
    }

    func revokePerson(_ person: Person, done: String) async {
        guard let workspace = person.workspace_id ?? selectedWorkspace else { return }
        _ = await mutate("revoke-person", ["workspaceId": workspace, "agentId": person.id], done: { _ in done })
    }

    func endSessions(_ person: Person) async {
        guard let workspace = person.workspace_id ?? selectedWorkspace else { return }
        _ = await mutate("end-sessions", ["workspaceId": workspace, "agentId": person.id], done: { data in
            let ended = data.ended ?? 0
            return ended == 0 ? "\(person.displayName) had no open sessions."
                : "\(person.displayName) was signed out of \(plural(ended, "session", "sessions"))."
        })
    }

    func signInLink(for person: Person) async {
        guard let workspace = person.workspace_id ?? selectedWorkspace,
              let data = await mutate("sign-in-link", ["workspaceId": workspace, "agentId": person.id], done: { _ in
                  "Sign-in link made for \(person.displayName)."
              }), let url = data.url else { return }
        let until = Clock.parse(data.expires_at).map { "Works once, valid until \(Clock.moment($0))." }
            ?? "Works once, for 15 minutes."
        reveal(Reveal(kind: .link, title: "Sign-in link for \(data.name ?? person.displayName)", detail: until, secret: url))
    }

    func createRoom(in workspace: WorkspaceSummary, name: String) async -> Bool {
        guard await mutate("create-room", ["workspaceId": workspace.id, "name": name], done: { _ in
                  "Room “\(name)” created in “\(workspace.name ?? "the workspace")”."
              }) != nil else { return false }
        activeSheet = nil
        return true
    }

    /// Saves a GitHub token for one organization in this workspace. It goes to the hub over stdin and is never shown again.
    func addGithubToken(to workspace: WorkspaceSummary, owner: String, token: String) async -> Bool {
        guard await mutate("add-github-token", ["workspaceId": workspace.id, "owner": owner, "token": token], done: { data in
                  data.replaced == true ? "Replaced the GitHub token for \(owner) in “\(workspace.name ?? "the workspace")”."
                      : "Saved a GitHub token for \(owner) in “\(workspace.name ?? "the workspace")”."
              }) != nil else { return false }
        activeSheet = nil
        return true
    }

    func removeGithubToken(_ entry: GithubToken) async {
        guard let workspace = selectedWorkspace else { return }
        _ = await mutate("remove-github-token", ["workspaceId": workspace, "owner": entry.owner], done: { _ in
            "Removed the GitHub token for \(entry.owner)."
        })
    }

    func archiveRoom(_ room: Room) async {
        guard let workspace = room.workspace_id ?? selectedWorkspace else { return }
        _ = await mutate("archive-room", ["workspaceId": workspace, "roomId": room.id], done: { _ in
            "Room “\(room.displayName)” archived."
        })
    }

    func createInvite(room: Room, label: String) async -> Bool {
        guard let workspace = room.workspace_id ?? selectedWorkspace else { return false }
        var fields = ["workspaceId": workspace, "roomId": room.id]
        if !label.isEmpty { fields["label"] = label }
        guard let data = await mutate("create-invite", fields, done: { _ in
            "Invite link made for “\(room.displayName)”."
        }) else { return false }
        guard let url = data.url else { activeSheet = nil; return true }
        let expiry = Clock.parse(data.invite?.expires_at).map { " (\(Clock.moment($0)))" } ?? ""
        let who = label.isEmpty ? "" : " for \(label)"
        reveal(Reveal(kind: .link, title: "Invite link\(who)",
                      detail: "Joins “\(room.displayName)” as a client. It works once and expires in 7 days\(expiry).",
                      secret: url))
        return true
    }

    func revokeInvite(_ invite: Invite) async {
        guard let workspace = invite.workspace_id ?? selectedWorkspace else { return }
        _ = await mutate("revoke-invite", ["workspaceId": workspace, "inviteId": invite.id], done: { _ in
            "Invite link revoked."
        })
    }

    // Small actions

    func confirm(_ title: String, _ message: String, button: String, destructive: Bool = true,
                 action: @escaping @MainActor () async -> Void) {
        confirmation = Confirmation(title: title, message: message, button: button, destructive: destructive, action: action)
    }

    func openStudio() {
        guard let url = URL(string: studioAddress) else { return }
        NSWorkspace.shared.open(url)
    }

    func copyPublicURL() {
        guard let url = publicURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
        note("Public address copied. Send invite and sign-in links separately and privately.")
    }
}

// MARK: - Small views

private enum Tone {
    case good, warn, bad, idle
    var color: Color {
        switch self {
        case .good: return Palette.mint
        case .warn: return Palette.amber
        case .bad: return Palette.red
        case .idle: return Palette.muted
        }
    }
}

private func serviceTone(_ state: String?) -> Tone {
    switch state {
    case "running": return .good
    case "stale", "unhealthy": return .warn
    case "blocked": return .bad
    default: return .idle
    }
}

private func serviceWord(_ state: String?) -> String {
    switch state {
    case "running": return "Running"
    case "stopped": return "Stopped"
    case "stale": return "Needs attention"
    case "blocked": return "Blocked"
    case "unhealthy": return "Not responding"
    case let other?: return other.capitalized
    case nil: return "Checking…"
    }
}

private struct StatusChip: View {
    let symbol: String
    let title: String
    let value: String
    let tone: Tone
    var help: String = ""

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(tone.color).frame(width: 6, height: 6)
            Image(systemName: symbol).font(.system(size: 10)).foregroundStyle(Palette.muted)
            Text(title).font(.system(size: 11, weight: .medium))
            Text(value).font(.system(size: 11, design: .monospaced)).foregroundStyle(tone.color).lineLimit(1)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(Palette.background.opacity(0.7), in: Capsule())
        .overlay(Capsule().stroke(tone.color.opacity(0.35), lineWidth: 1))
        .help(help)
        .accessibilityElement(children: .combine)
    }
}

private struct Badge: View {
    let text: String
    let color: Color
    init(_ text: String, _ color: Color) { self.text = text; self.color = color }
    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}

private struct RowCard<Info: View, Actions: View>: View {
    let info: Info
    let actions: Actions
    init(@ViewBuilder info: () -> Info, @ViewBuilder actions: () -> Actions) {
        self.info = info()
        self.actions = actions()
    }
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) { info }
            Spacer(minLength: 12)
            HStack(spacing: 6) { actions }.controlSize(.small)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Palette.panel, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct SectionHeader: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Palette.lilac)
            Text(subtitle).font(.system(size: 11)).foregroundStyle(Palette.muted)
        }
    }
}

private struct EmptyNote: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 11)).foregroundStyle(Palette.muted)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.panel.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
}

private func metaText(_ parts: [String]) -> some View {
    Text(parts.filter { !$0.isEmpty }.joined(separator: " · "))
        .font(.system(size: 11)).foregroundStyle(Palette.muted)
        .fixedSize(horizontal: false, vertical: true)
}

private func lastSeen(_ person: Person) -> String {
    Clock.parse(person.last_seen_at).map { "Last seen \(Clock.relative($0))" } ?? "Not seen yet"
}

// MARK: - Service bar

private struct ServiceBar: View {
    @ObservedObject var model: StudioModel

    private var alertChip: StatusChip {
        let open = model.snapshot?.alerts?.open ?? 0
        let high = model.snapshot?.alerts?.high ?? 0
        let tone: Tone = model.snapshot?.alerts == nil ? .idle : high > 0 ? .bad : open > 0 ? .warn : .good
        let value = model.snapshot?.alerts == nil ? "—" : open == 0 ? "None" : "\(open) open"
        return StatusChip(symbol: "shield.lefthalf.filled", title: "Security", value: value, tone: tone,
                          help: high > 0 ? "\(plural(high, "serious alert", "serious alerts")). Review them in the Studio's Security view."
                              : "Open security alerts. Review them in the Studio's Security view.")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("COLLAB STUDIO").font(.system(size: 13, weight: .semibold, design: .monospaced))
                Text("control room").font(.system(size: 11)).foregroundStyle(Palette.muted)
                Spacer()
                if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Working") }
                launchButton
                tunnelButton
                Button { model.openStudio() } label: { Label("Open Studio", systemImage: "safari") }
                    .disabled(!model.hubRunning)
                Button { model.activeSheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
            }
            .padding(.leading, 70) // clear the window buttons
            .disabled(model.busy)

            HStack(spacing: 8) {
                StatusChip(symbol: "server.rack", title: "Hub", value: serviceWord(model.snapshot?.hub?.state),
                           tone: serviceTone(model.snapshot?.hub?.state), help: model.snapshot?.hub?.detail ?? "The hub on this Mac at 127.0.0.1:8791.")
                StatusChip(symbol: "network", title: "Tunnel", value: serviceWord(model.snapshot?.tunnel?.state),
                           tone: serviceTone(model.snapshot?.tunnel?.state), help: model.snapshot?.tunnel?.detail ?? "The public ngrok address.")
                StatusChip(symbol: "shippingbox", title: "Docker",
                           value: model.snapshot == nil ? "Checking…" : model.snapshot?.dockerAvailable == true ? "Ready" : "Unavailable",
                           tone: model.snapshot?.dockerAvailable == true ? .good : model.snapshot == nil ? .idle : .warn,
                           help: "Rooms' sandboxes and clients' sidekicks run in Docker containers.")
                // The hub starts the gate the first time a room or sidekick needs the internet, so "stopped"
                // while the hub runs just means nothing has needed it yet.
                let gateIdle = model.snapshot?.gate?.state == "stopped" && model.snapshot?.hub?.state == "running"
                StatusChip(symbol: "lock.shield", title: "Egress gate", value: gateIdle ? "Starts when needed" : serviceWord(model.snapshot?.gate?.state),
                           tone: gateIdle ? .idle : model.snapshot?.gate?.state == "stopped" ? .warn : serviceTone(model.snapshot?.gate?.state),
                           help: "The only way containers reach the internet, and only to approved addresses. The hub starts it the first time a room or sidekick needs it.")
                alertChip
                Spacer(minLength: 8)
                if let url = model.publicURL {
                    Text(url.absoluteString).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.blue)
                        .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    Button { model.copyPublicURL() } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.borderless).help("Copy the public address")
                }
            }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
        .background(Palette.panel)
    }

    @ViewBuilder private var launchButton: some View {
        if model.hubRunning {
            Button { confirmStop() } label: { Label("Stop", systemImage: "stop.fill") }
        } else {
            Button { launch() } label: { Label("Launch", systemImage: "play.fill") }
                .buttonStyle(.borderedProminent).tint(Palette.mint).foregroundStyle(Palette.background)
        }
    }

    @ViewBuilder private var tunnelButton: some View {
        if model.tunnelRunning {
            Button { Task { await model.operate("stop-tunnel") } } label: { Label("Stop Tunnel", systemImage: "network.slash") }
        } else {
            Button { confirmTunnel() } label: { Label("Start Tunnel", systemImage: "network") }
                .disabled(!model.hubRunning)
        }
    }

    private static let exposure = "This starts an ngrok tunnel so people outside this Mac can open the Studio at a public web address. Everyone still needs their own token, invite link or sign-in. You can stop the tunnel at any time."

    private func launch() {
        if model.settings.tunnelOnLaunch {
            model.confirm("Launch and make the hub reachable from the internet?", Self.exposure,
                          button: "Launch with Tunnel", destructive: false) { await model.launch() }
        } else {
            Task { await model.launch() }
        }
    }

    private func confirmTunnel() {
        model.confirm("Make the hub reachable from the internet?", Self.exposure, button: "Start Tunnel", destructive: false) {
            await model.operate("start-tunnel")
        }
    }

    private func confirmStop() {
        model.confirm("Stop the hub?",
                      "The tunnel stops first, then the hub. People in the Studio are disconnected until you launch again. Nothing is deleted: rooms, files, history and sidekick containers stay.",
                      button: "Stop") { await model.operate("stop-all") }
    }
}

// MARK: - Database banner

private struct DatabaseBanner: View {
    @ObservedObject var model: StudioModel
    let status: DatabaseStatus

    private var versions: String {
        let found = status.version.map(String.init) ?? "unknown"
        let expected = status.expected.map(String.init) ?? "unknown"
        return "data version \(found); this app expects \(expected)"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.amber).font(.system(size: 16))
            VStack(alignment: .leading, spacing: 4) {
                if status.state == "outdated" {
                    Text("This hub's data is from an older version.").font(.system(size: 13, weight: .semibold))
                    Text("It was saved by an earlier Collab Studio (\(versions)). Upgrade it to keep your workspaces, people and rooms, or start fresh with an empty hub. Nothing changes until you choose.")
                } else {
                    Text("This hub's data is from a newer version.").font(.system(size: 13, weight: .semibold))
                    Text("It was saved by a newer Collab Studio (\(versions)). Update this copy of the app and hub to keep using it, or start fresh with an empty hub. Nothing changes until you choose.")
                }
            }
            .font(.system(size: 12))
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 12)
            if status.state == "outdated" {
                Button("Upgrade (keep data)…") {
                    model.confirm("Upgrade this hub's data?",
                                  "The hub restarts. A backup copy of the current data is made first, then the data is upgraded in place. Everyone keeps their access.",
                                  button: "Upgrade", destructive: false) { await model.upgrade() }
                }
            }
            Button("Start fresh…") { model.activeSheet = .freshStart }
        }
        .disabled(model.busy)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Palette.amber.opacity(0.10))
    }
}

private struct BackupNote: View {
    @ObservedObject var model: StudioModel
    let path: String
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "archivebox").foregroundStyle(Palette.mint)
            Text("The previous data was kept in a private backup:").font(.system(size: 12))
            Text(path).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if path.hasPrefix("/") {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            }
            Button { model.backupPath = nil } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Hide")
        }
        .textSelection(.enabled)
        .controlSize(.small)
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(Palette.mint.opacity(0.08))
    }
}

// MARK: - Sidebar

private struct Sidebar: View {
    @ObservedObject var model: StudioModel

    private var unavailableReason: String {
        switch model.databaseState {
        case "none": return "No hub data yet. Press Launch: the hub sets up its data the first time it starts."
        case "outdated", "newer": return "Workspaces are available once the hub's data is upgraded or started fresh. See the note above."
        case nil: return model.snapshot == nil ? "Checking the hub…" : "The hub's data could not be checked."
        default: return "The hub's data isn't ready."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("WORKSPACES").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 6)
            if model.canManage {
                if model.workspaces.isEmpty {
                    Text("No workspaces yet. Create one to invite people.").font(.system(size: 11)).foregroundStyle(Palette.muted)
                        .padding(.horizontal, 16).padding(.vertical, 6)
                    Spacer()
                } else {
                    List(selection: Binding(get: { model.selectedWorkspace }, set: { if let id = $0 { model.select(id) } })) {
                        ForEach(model.workspaces) { workspace in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(workspace.name ?? "Untitled").font(.system(size: 13, weight: .medium)).lineLimit(1)
                                Text("\(plural(workspace.people ?? 0, "person", "people")) · \(plural(workspace.rooms ?? 0, "room", "rooms"))")
                                    .font(.system(size: 10)).foregroundStyle(Palette.muted)
                            }
                            .padding(.vertical, 3)
                            .tag(workspace.id as String?)
                        }
                    }
                    .listStyle(.sidebar)
                    .scrollContentBackground(.hidden)
                }
            } else {
                Text(unavailableReason).font(.system(size: 11)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                Spacer()
            }
            Divider()
            Button { model.activeSheet = .newWorkspace } label: {
                Label("New workspace", systemImage: "plus").frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .disabled(!model.canManage || model.busy)
        }
        .background(Palette.panel.opacity(0.55))
    }
}

// MARK: - Workspace detail

private enum DetailTab: Hashable { case people, rooms, links, github }

private struct WorkspaceDetail: View {
    @ObservedObject var model: StudioModel
    @State private var tab: DetailTab = .people

    var body: some View {
        if let workspace = model.selectedSummary, model.canManage {
            VStack(alignment: .leading, spacing: 0) {
                header(workspace)
                if let error = model.listError {
                    Text(error).font(.system(size: 11)).foregroundStyle(Palette.amber)
                        .padding(.horizontal, 24).padding(.bottom, 8)
                }
                ScrollView {
                    Group {
                        switch tab {
                        case .people: PeopleTab(model: model)
                        case .rooms: RoomsTab(model: model)
                        case .links: LinksTab(model: model)
                        case .github: GitHubTab(model: model)
                        }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } else {
            VStack(spacing: 10) {
                Image(systemName: "rectangle.3.group").font(.system(size: 34)).foregroundStyle(Palette.muted.opacity(0.6))
                Text(model.canManage ? "Create a workspace to get started." : "Workspaces appear here once the hub's data is ready.")
                    .font(.system(size: 13)).foregroundStyle(Palette.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func header(_ workspace: WorkspaceSummary) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(workspace.name ?? "Untitled").font(.system(size: 20, weight: .semibold))
                    metaText([plural(workspace.people ?? 0, "person", "people"), plural(workspace.rooms ?? 0, "room", "rooms"),
                              Clock.parse(workspace.created_at).map { "created \(Clock.relative($0))" } ?? ""])
                }
                Spacer()
                Button { Task { await model.refreshList(.user) } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh").disabled(model.busy)
                Button("Rename…") { model.activeSheet = .rename(workspace) }.disabled(model.busy)
                Button("Delete…", role: .destructive) { model.activeSheet = .deleteWorkspace(workspace) }.disabled(model.busy)
            }
            Picker("Section", selection: $tab) {
                Text("People (\(model.people.filter { $0.active != false }.count))").tag(DetailTab.people)
                Text("Rooms (\(model.rooms.count))").tag(DetailTab.rooms)
                Text("Links (\(model.invites.count))").tag(DetailTab.links)
                Text("GitHub (\(model.githubTokens.count))").tag(DetailTab.github)
            }
            .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 500)
        }
        .padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 4)
    }
}

// MARK: People

private struct PeopleTab: View {
    @ObservedObject var model: StudioModel

    private var active: [Person] {
        model.people.filter { $0.active != false }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    var body: some View {
        let people = active
        let staff = people.filter { $0.group == "staff" }
        let clients = people.filter { $0.group == "client" }
        let sidekicks = people.filter { $0.group == "sidekick" }
        let older = people.filter { $0.group == "agent" }
        let removed = model.people.count - people.count
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Spacer()
                Button { if let w = model.selectedSummary { model.activeSheet = .addStaff(w) } } label: { Label("Add staff", systemImage: "plus") }
                    .disabled(model.busy)
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Staff", subtitle: "Your team. They sign in to the Studio with a token.")
                if staff.isEmpty { EmptyNote("No staff yet.") }
                ForEach(staff) { StaffRow(model: model, person: $0) }
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Clients", subtitle: "They join through an invite link, then sign in every 3 hours with a passkey or a sign-in link.")
                if clients.isEmpty { EmptyNote("No clients yet. Make an invite link from the Rooms tab.") }
                ForEach(clients) { ClientRow(model: model, person: $0) }
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Sidekicks", subtitle: "Clients' own Claude or ChatGPT helpers, each running in a container on this Mac.")
                if sidekicks.isEmpty { EmptyNote("No sidekicks yet. Clients can add one after they join.") }
                ForEach(sidekicks) { person in
                    SidekickRow(model: model, person: person,
                                owner: model.people.first { $0.id == person.owner_id }?.displayName)
                }
            }
            if !older.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeader(title: "Older agent identities", subtitle: "Made by an earlier version. They can only be revoked.")
                    ForEach(older) { OlderAgentRow(model: model, person: $0) }
                }
            }
            if removed > 0 {
                Text("\(plural(removed, "person", "people")) whose access was removed \(removed == 1 ? "is" : "are") not shown.")
                    .font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
        }
    }
}

private struct StaffRow: View {
    @ObservedObject var model: StudioModel
    let person: Person
    var body: some View {
        RowCard {
            HStack(spacing: 8) {
                Text(person.displayName).font(.system(size: 13, weight: .medium))
                if person.role == "observer" { Badge("OBSERVER (READ-ONLY)", Palette.blue) } else { Badge("STAFF (FULL)", Palette.mint) }
            }
            metaText([lastSeen(person)])
        } actions: {
            Button("New token") { Task { await model.newToken(for: person) } }
            Button("Revoke…", role: .destructive) {
                let name = person.displayName
                model.confirm("Revoke \(name)'s access?",
                              "All of \(name)'s tokens stop working right away. Their messages stay in the rooms.",
                              button: "Revoke") { await model.revokePerson(person, done: "\(name)'s access was revoked.") }
            }
        }
        .disabled(model.busy)
    }
}

private struct ClientRow: View {
    @ObservedObject var model: StudioModel
    let person: Person

    private var session: (String, Color) {
        if let until = Clock.parse(person.session_until), until > Date() {
            return ("Signed in until \(Clock.moment(until))", Palette.mint)
        }
        return ("Signed out", Palette.muted)
    }

    private var passkeys: String {
        let count = person.passkeys ?? 0
        return count == 0 ? "No passkey yet" : plural(count, "passkey", "passkeys")
    }

    var body: some View {
        RowCard {
            HStack(spacing: 8) {
                Text(person.displayName).font(.system(size: 13, weight: .medium))
                Badge("CLIENT", Palette.lilac)
            }
            HStack(spacing: 0) {
                Text(session.0).font(.system(size: 11)).foregroundStyle(session.1)
                Text(" · ").font(.system(size: 11)).foregroundStyle(Palette.muted)
                metaText([passkeys, lastSeen(person)])
            }
            if let sidekick = person.sidekick {
                HStack(spacing: 5) {
                    Image(systemName: "sparkles").font(.system(size: 10)).foregroundStyle(Palette.amber)
                    metaText(["Sidekick: \(sidekick.name ?? "Unnamed")", providerName(sidekick.provider),
                              sidekick.asleep == true ? "asleep" : sidekick.signed_in == true ? "signed in" : "signed out"])
                }
            }
        } actions: {
            Button("Sign-in link") { Task { await model.signInLink(for: person) } }
            Button("Sign out everywhere…") {
                let name = person.displayName
                model.confirm("Sign \(name) out everywhere?",
                              "Every open session ends now. \(name) keeps access and can sign in again with a passkey or a new sign-in link.",
                              button: "Sign Out") { await model.endSessions(person) }
            }
            Button("Remove access…", role: .destructive) {
                let name = person.displayName
                model.confirm("Remove \(name)'s access?",
                              "\(name) is signed out everywhere and can no longer sign in. To come back they would need a new invite link. Their messages stay in the rooms.",
                              button: "Remove Access") { await model.revokePerson(person, done: "\(name)'s access was removed.") }
            }
        }
        .disabled(model.busy)
    }
}

private struct SidekickRow: View {
    @ObservedObject var model: StudioModel
    let person: Person
    let owner: String?
    var body: some View {
        RowCard {
            HStack(spacing: 8) {
                Text(person.displayName).font(.system(size: 13, weight: .medium))
                Badge("SIDEKICK", Palette.amber)
            }
            HStack(spacing: 0) {
                metaText(["For \(owner ?? "a client who was removed")", providerName(person.provider)])
                Text(" · ").font(.system(size: 11)).foregroundStyle(Palette.muted)
                Text(person.signed_in == true ? "Signed in" : "Signed out").font(.system(size: 11))
                    .foregroundStyle(person.signed_in == true ? Palette.mint : Palette.muted)
            }
            metaText([lastSeen(person)])
        } actions: {
            Button("Remove access…", role: .destructive) {
                let name = person.displayName
                model.confirm("Remove the sidekick \(name)?",
                              "This sidekick can no longer read or post in rooms. \(owner ?? "Its owner") keeps their own access.",
                              button: "Remove Access") { await model.revokePerson(person, done: "Sidekick \(name) was removed.") }
            }
        }
        .disabled(model.busy)
    }
}

private struct OlderAgentRow: View {
    @ObservedObject var model: StudioModel
    let person: Person
    var body: some View {
        RowCard {
            HStack(spacing: 8) {
                Text(person.displayName).font(.system(size: 13, weight: .medium))
                Badge("OLDER AGENT", Palette.muted)
            }
            metaText([lastSeen(person)])
        } actions: {
            Button("Revoke…", role: .destructive) {
                let name = person.displayName
                model.confirm("Revoke \(name)?",
                              "All of this identity's tokens stop working right away. Its messages stay in the rooms.",
                              button: "Revoke") { await model.revokePerson(person, done: "\(name) was revoked.") }
            }
        }
        .disabled(model.busy)
    }
}

// MARK: Rooms

private struct RoomsTab: View {
    @ObservedObject var model: StudioModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom) {
                SectionHeader(title: "Rooms", subtitle: "Where staff, clients and sidekicks work together.")
                Spacer()
                Button { if let w = model.selectedSummary { model.activeSheet = .newRoom(w) } } label: { Label("New room", systemImage: "plus") }
                    .disabled(model.busy)
            }
            .padding(.bottom, 6)
            if model.rooms.isEmpty { EmptyNote("No rooms yet. Create one, then invite clients to it.") }
            ForEach(model.rooms.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }) { room in
                RowCard {
                    Text(room.displayName).font(.system(size: 13, weight: .medium))
                    metaText([plural(room.members ?? 0, "member", "members"),
                              room.sandbox.map { "Sandbox: \($0)" } ?? "No sandbox",
                              Clock.parse(room.created_at).map { "created \(Clock.relative($0))" } ?? ""])
                } actions: {
                    Button("Invite client…") { model.activeSheet = .invite(room) }
                    Button("Archive…", role: .destructive) {
                        model.confirm("Archive “\(room.displayName)”?",
                                      "The room disappears for everyone and can't be used any more. Its messages are kept in the hub's data.",
                                      button: "Archive") { await model.archiveRoom(room) }
                    }
                }
                .disabled(model.busy)
            }
        }
    }
}

// MARK: GitHub

private struct GitHubTab: View {
    @ObservedObject var model: StudioModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom) {
                SectionHeader(title: "GitHub tokens",
                              subtitle: "One token per GitHub organization. Clones and pull requests in this workspace's rooms use the token for the repository's organization.")
                Spacer()
                Button { if let w = model.selectedSummary { model.activeSheet = .addGithubToken(w, nil) } } label: { Label("Add token", systemImage: "plus") }
                    .disabled(model.busy)
            }
            .padding(.bottom, 6)
            if model.githubTokens.isEmpty {
                EmptyNote("No GitHub tokens yet. Public repositories clone without one; private ones need a token for their organization.")
            }
            ForEach(model.githubTokens.sorted { $0.owner.localizedCaseInsensitiveCompare($1.owner) == .orderedAscending }) { entry in
                RowCard {
                    Text(entry.owner).font(.system(size: 13, weight: .medium))
                    metaText(["Repositories under github.com/\(entry.owner)",
                              Clock.parse(entry.added_at).map { "added \(Clock.relative($0))" } ?? ""])
                } actions: {
                    Button("Replace…") { if let w = model.selectedSummary { model.activeSheet = .addGithubToken(w, entry.owner) } }
                    Button("Remove…", role: .destructive) {
                        model.confirm("Remove the GitHub token for \(entry.owner)?",
                                      "Rooms in this workspace can no longer clone private \(entry.owner) repositories or open pull requests there. Clones already made stay as they are.",
                                      button: "Remove") { await model.removeGithubToken(entry) }
                    }
                }
                .disabled(model.busy)
            }
        }
    }
}

// MARK: Links

private struct LinksTab: View {
    @ObservedObject var model: StudioModel

    private func stateBadge(_ state: String?) -> Badge {
        switch state {
        case "open": return Badge("OPEN", Palette.mint)
        case "used": return Badge("USED", Palette.blue)
        case "expired": return Badge("EXPIRED", Palette.muted)
        case "revoked": return Badge("REVOKED", Palette.red)
        default: return Badge((state ?? "unknown").uppercased(), Palette.muted)
        }
    }

    var body: some View {
        let sorted = model.invites.sorted { (Clock.parse($0.created_at) ?? .distantPast) > (Clock.parse($1.created_at) ?? .distantPast) }
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Invite links", subtitle: "Each invite link lets one client join a room. Make new ones from the Rooms tab.")
                .padding(.bottom, 6)
            if sorted.isEmpty { EmptyNote("No invite links yet.") }
            ForEach(sorted) { invite in
                RowCard {
                    HStack(spacing: 8) {
                        Text(invite.label?.isEmpty == false ? invite.label! : "Invite link").font(.system(size: 13, weight: .medium))
                        stateBadge(invite.state)
                    }
                    metaText(["Room: \(model.rooms.first { $0.id == invite.room_id }?.displayName ?? "an archived room")",
                              Clock.parse(invite.created_at).map { "made \(Clock.relative($0))" } ?? "",
                              Clock.parse(invite.expires_at).map { ($0 < Date() ? "expired " : "expires ") + Clock.moment($0) } ?? ""])
                } actions: {
                    if invite.state == "open" {
                        Button("Revoke…", role: .destructive) {
                            model.confirm("Revoke this invite link?",
                                          "The link stops working. Anyone who already joined with it keeps their access.",
                                          button: "Revoke") { await model.revokeInvite(invite) }
                        }
                    }
                }
                .disabled(model.busy)
            }
            Text("Sign-in links aren't listed; each one works once for 15 minutes.")
                .font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.top, 8)
        }
    }
}

// MARK: - Sheets

private struct FormSheet<Fields: View>: View {
    @ObservedObject var model: StudioModel
    let title: String
    let explanation: String
    let actionTitle: String
    var destructive = false
    let canSubmit: Bool
    let submit: () async -> Bool
    let fields: Fields
    @State private var running = false
    @State private var error: String?

    init(model: StudioModel, title: String, explanation: String, actionTitle: String, destructive: Bool = false,
         canSubmit: Bool, submit: @escaping () async -> Bool, @ViewBuilder fields: () -> Fields) {
        self.model = model
        self.title = title
        self.explanation = explanation
        self.actionTitle = actionTitle
        self.destructive = destructive
        self.canSubmit = canSubmit
        self.submit = submit
        self.fields = fields()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.system(size: 17, weight: .semibold))
            Text(explanation).font(.system(size: 12)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
            fields
            if let error {
                Text(error).font(.system(size: 11)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if running { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { model.activeSheet = nil }.keyboardShortcut(.cancelAction).disabled(running)
                Button(actionTitle, role: destructive ? .destructive : nil) { run() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit || running || model.busy)
            }
        }
        .padding(24)
        .frame(width: 470)
    }

    private func run() {
        running = true
        error = nil
        Task {
            let ok = await submit()
            running = false
            if !ok { error = model.failed ? model.message : "That didn't work. Please try again." }
        }
    }
}

private struct NewWorkspaceSheet: View {
    @ObservedObject var model: StudioModel
    @State private var name = ""
    var body: some View {
        let owner = trimmed(model.settings.ownerName)
        FormSheet(model: model, title: "New workspace",
                  explanation: "A workspace keeps one project's rooms and people together. You'll also get a staff token for yourself, named “\(owner.isEmpty ? "you" : owner)” (from Settings › Your name), shown once so you can sign in to the Studio.",
                  actionTitle: "Create Workspace", canSubmit: !trimmed(name).isEmpty && !owner.isEmpty,
                  submit: { await model.createWorkspace(name: trimmed(name)) }) {
            TextField("Workspace name", text: $name).textFieldStyle(.roundedBorder)
            if owner.isEmpty {
                Text("Add your name in Settings first.").font(.system(size: 11)).foregroundStyle(Palette.amber)
            }
        }
    }
}

private struct RenameSheet: View {
    @ObservedObject var model: StudioModel
    let workspace: WorkspaceSummary
    @State private var name: String
    init(model: StudioModel, workspace: WorkspaceSummary) {
        self.model = model
        self.workspace = workspace
        _name = State(initialValue: workspace.name ?? "")
    }
    var body: some View {
        FormSheet(model: model, title: "Rename workspace", explanation: "Everyone in the workspace sees the new name.",
                  actionTitle: "Rename", canSubmit: !trimmed(name).isEmpty && trimmed(name) != workspace.name,
                  submit: { await model.renameWorkspace(workspace.id, to: trimmed(name)) }) {
            TextField("Workspace name", text: $name).textFieldStyle(.roundedBorder)
        }
    }
}

private struct DeleteWorkspaceSheet: View {
    @ObservedObject var model: StudioModel
    let workspace: WorkspaceSummary
    @State private var typed = ""
    var body: some View {
        FormSheet(model: model, title: "Delete “\(workspace.name ?? "workspace")”",
                  explanation: "Everyone in this workspace loses access right away: staff tokens, client sign-ins and passkeys, and open links. Its rooms, messages, sidekicks and their containers are removed. A copy of the data and the room files goes into a dated private backup first. Other workspaces aren't affected.",
                  actionTitle: "Delete Workspace", destructive: true, canSubmit: typed == (workspace.name ?? ""),
                  submit: { await model.deleteWorkspace(workspace.id, confirmName: typed) }) {
            Text("Type the workspace name to confirm:").font(.system(size: 11)).foregroundStyle(Palette.muted)
            TextField(workspace.name ?? "", text: $typed).textFieldStyle(.roundedBorder)
        }
    }
}

private struct AddStaffSheet: View {
    @ObservedObject var model: StudioModel
    let workspace: WorkspaceSummary
    @State private var name = ""
    @State private var role = "supervisor"
    var body: some View {
        FormSheet(model: model, title: "Add staff to “\(workspace.name ?? "workspace")”",
                  explanation: "Staff sign in to the Studio with a token. The token is shown once; send it to them privately.",
                  actionTitle: "Add Staff", canSubmit: !trimmed(name).isEmpty,
                  submit: { await model.addStaff(to: workspace, name: trimmed(name), role: role) }) {
            TextField("Name", text: $name).textFieldStyle(.roundedBorder)
            Picker("Access", selection: $role) {
                Text("Staff (full)").tag("supervisor")
                Text("Observer (read-only)").tag("observer")
            }
            .pickerStyle(.radioGroup)
            Text(role == "supervisor" ? "Can run rooms, invite clients and work in every room of this workspace."
                 : "Can look at everything in this workspace but can't change anything.")
                .font(.system(size: 11)).foregroundStyle(Palette.muted)
        }
    }
}

private struct NewRoomSheet: View {
    @ObservedObject var model: StudioModel
    let workspace: WorkspaceSummary
    @State private var name = ""
    var body: some View {
        FormSheet(model: model, title: "New room in “\(workspace.name ?? "workspace")”", explanation: "Staff can use the room right away. Invite clients to it afterwards.",
                  actionTitle: "Create Room", canSubmit: !trimmed(name).isEmpty,
                  submit: { await model.createRoom(in: workspace, name: trimmed(name)) }) {
            TextField("Room name", text: $name).textFieldStyle(.roundedBorder)
        }
    }
}

private struct AddGithubTokenSheet: View {
    @ObservedObject var model: StudioModel
    let workspace: WorkspaceSummary
    let existing: String?
    @State private var owner: String
    @State private var token = ""

    init(model: StudioModel, workspace: WorkspaceSummary, existing: String?) {
        self.model = model; self.workspace = workspace; self.existing = existing
        _owner = State(initialValue: existing ?? "")
    }

    /// GitHub's name for the organization: spaces become hyphens, and a pasted github.com link gives its owner.
    private var normalizedOwner: String {
        var text = trimmed(owner)
        if let found = text.range(of: "github.com/", options: .caseInsensitive) { text = String(text[found.upperBound...]) }
        text = text.split(separator: "/").first.map(String.init) ?? text
        return text.split(whereSeparator: { $0.isWhitespace }).joined(separator: "-")
    }
    private var ownerOK: Bool { normalizedOwner.range(of: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$", options: .regularExpression) != nil }
    private var tokenOK: Bool { trimmed(token).range(of: "^[A-Za-z0-9_]{20,255}$", options: .regularExpression) != nil }

    var body: some View {
        FormSheet(model: model, title: existing == nil ? "Add a GitHub token to “\(workspace.name ?? "workspace")”" : "Replace the GitHub token for \(existing!)",
                  explanation: "Clones and pull requests in this workspace use this token for repositories owned by the organization below. Other workspaces never see it.",
                  actionTitle: existing == nil ? "Save Token" : "Replace Token", canSubmit: ownerOK && tokenOK,
                  submit: { await model.addGithubToken(to: workspace, owner: normalizedOwner, token: trimmed(token)) }) {
            TextField("GitHub organization, or paste a repository link", text: $owner).textFieldStyle(.roundedBorder)
                .disabled(existing != nil)
            if !trimmed(owner).isEmpty {
                Text(ownerOK ? "Saves as \(normalizedOwner): used for github.com/\(normalizedOwner)/… repositories."
                             : "Use the name from the repository's address: github.com/acme/web-app → acme.")
                    .font(.system(size: 11)).foregroundStyle(ownerOK ? Palette.muted : Palette.amber)
            }
            SecureField("Paste the token (github_pat_…)", text: $token).textFieldStyle(.roundedBorder)
            if !trimmed(token).isEmpty && !tokenOK {
                Text("That doesn't look like a whole GitHub token. Copy it again from GitHub.").font(.system(size: 11)).foregroundStyle(Palette.amber)
            }
            Text("Use a fine-grained token whose resource owner is that organization. Give it Contents: read to clone; add Contents: read and write and Pull requests: read and write to open pull requests. The token is saved in the hub's private data folder on this Mac and is never shown again.")
                .font(.system(size: 11)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct InviteSheet: View {
    @ObservedObject var model: StudioModel
    let room: Room
    @State private var label = ""
    var body: some View {
        FormSheet(model: model, title: "Invite a client to “\(room.displayName)”",
                  explanation: "You'll get a link that lets one person join this room as a client. It works once and expires in 7 days.",
                  actionTitle: "Make Invite Link", canSubmit: true,
                  submit: { await model.createInvite(room: room, label: trimmed(label)) }) {
            TextField("Who is it for? (optional)", text: $label).textFieldStyle(.roundedBorder)
            Text("The label only helps you recognise the link on the Links tab.").font(.system(size: 11)).foregroundStyle(Palette.muted)
        }
    }
}

private struct FreshStartSheet: View {
    @ObservedObject var model: StudioModel
    @State private var typed = ""
    var body: some View {
        FormSheet(model: model, title: "Start fresh",
                  explanation: "This gives you an empty hub. Read what happens before you continue.",
                  actionTitle: "Start Fresh", destructive: true, canSubmit: typed == "START FRESH",
                  submit: { await model.freshStart() }) {
            VStack(alignment: .leading, spacing: 6) {
                bullet("The hub and the tunnel stop.")
                bullet("All current data and room files are moved into a dated private backup folder. Nothing is deleted.")
                bullet("Everyone's access ends: staff tokens, client passkeys, sidekicks, invite links and sign-in links stop working.")
                bullet("The hub starts again, empty. You'll create new workspaces and invite people again.")
            }
            Text("Type START FRESH to confirm.").font(.system(size: 12, weight: .medium))
            TextField("START FRESH", text: $typed).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
        }
    }
    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("•").foregroundStyle(Palette.amber)
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 12))
    }
}

private struct RevealSheet: View {
    @ObservedObject var model: StudioModel
    let reveal: Reveal
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(reveal.title, systemImage: reveal.kind == .token ? "key.fill" : "link")
                .font(.system(size: 16, weight: .semibold))
            if let detail = reveal.detail {
                Text(detail).font(.system(size: 12)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            Text(reveal.secret)
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.background, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.muted.opacity(0.3), lineWidth: 1))
            Text("This is shown once. Send it privately; never paste it into a chat room.")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.amber)
            Text(copied ? "Copied. The clipboard clears itself after 60 seconds."
                 : "Copying clears the clipboard after 60 seconds if it still holds this.")
                .font(.system(size: 11)).foregroundStyle(Palette.muted)
            HStack {
                Button { SecretClipboard.copy(reveal.secret); copied = true } label: { Label("Copy", systemImage: "doc.on.doc") }
                Spacer()
                Button("Done") { model.activeSheet = nil }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 500)
    }
}

private struct SettingsSheet: View {
    @ObservedObject var model: StudioModel
    @State private var draft: Settings
    @State private var running = false
    @State private var error: String?

    init(model: StudioModel) {
        self.model = model
        _draft = State(initialValue: model.settings)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Settings").font(.system(size: 17, weight: .semibold))
            pathField("Hub folder (agent-collab-hub checkout)", \.repository, folder: true)
            pathField("Node.js 22+", \.nodePath)
            pathField("npm", \.npmPath)
            pathField("ngrok", \.ngrokPath)
            VStack(alignment: .leading, spacing: 5) {
                caption("Sandbox image")
                TextField("Sandbox image", text: $draft.sandboxImage)
                    .font(.system(size: 11, design: .monospaced)).textFieldStyle(.roundedBorder)
                Text("Used for new rooms' sandboxes from the next launch. Default: \(Settings.defaultSandboxImage).")
                    .font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
            VStack(alignment: .leading, spacing: 5) {
                caption("Your name")
                TextField("Your name", text: $draft.ownerName).textFieldStyle(.roundedBorder)
                Text("Names your own staff token when you create a workspace.").font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
            Toggle("Open Studio after launch", isOn: $draft.openConsole)
            Toggle("Start tunnel on launch", isOn: $draft.tunnelOnLaunch)
            Text("You'll be asked to confirm at each launch, because the tunnel makes the hub reachable from the internet.")
                .font(.system(size: 10)).foregroundStyle(Palette.muted)
            if let error {
                Text(error).font(.system(size: 11)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if running { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { model.activeSheet = nil }.keyboardShortcut(.cancelAction).disabled(running)
                Button("Save & Validate") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(running || model.busy || trimmed(draft.ownerName).isEmpty)
            }
        }
        .font(.system(size: 12))
        .toggleStyle(.checkbox)
        .padding(24)
        .frame(width: 540)
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.muted)
    }

    private func pathField(_ label: String, _ keyPath: WritableKeyPath<Settings, String>, folder: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            caption(label)
            HStack {
                TextField(label, text: Binding(get: { draft[keyPath: keyPath] }, set: { draft[keyPath: keyPath] = $0 }))
                    .font(.system(size: 11, design: .monospaced)).textFieldStyle(.roundedBorder)
                Button { choose(keyPath, folder: folder) } label: { Image(systemName: "folder") }
                    .help("Choose \(label)")
            }
        }
    }

    private func choose(_ keyPath: WritableKeyPath<Settings, String>, folder: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = folder
        panel.canChooseFiles = !folder
        panel.allowsMultipleSelection = false
        panel.prompt = "Select"
        panel.message = folder ? "Choose the agent-collab-hub checkout." : "Choose the installed executable."
        if panel.runModal() == .OK, let url = panel.url { draft[keyPath: keyPath] = url.path }
    }

    private func save() {
        running = true
        error = nil
        var candidate = draft
        candidate.ownerName = trimmed(candidate.ownerName)
        candidate.sandboxImage = trimmed(candidate.sandboxImage)
        if candidate.sandboxImage.isEmpty { candidate.sandboxImage = Settings.defaultSandboxImage }
        Task {
            let ok = await model.validateAndSave(candidate)
            running = false
            if !ok { error = model.message }
        }
    }
}

// MARK: - Main view

private struct StudioView: View {
    @StateObject private var model = StudioModel()

    var body: some View {
        VStack(spacing: 0) {
            ServiceBar(model: model)
            if let database = model.snapshot?.database, ["outdated", "newer"].contains(database.state ?? "") {
                DatabaseBanner(model: model, status: database)
            }
            if let path = model.backupPath, !path.isEmpty {
                BackupNote(model: model, path: path)
            }
            Divider()
            HStack(spacing: 0) {
                Sidebar(model: model).frame(width: 250)
                Divider()
                WorkspaceDetail(model: model).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            statusLine
        }
        .frame(minWidth: 960, idealWidth: 1100, minHeight: 600, idealHeight: 720)
        .background(Palette.background)
        .preferredColorScheme(.dark)
        .task {
            await model.refreshStatus(.follow)
            await model.refreshList(.follow)
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if Task.isCancelled { break }
                await model.refreshStatus(.background)
                tick += 1
                if tick % 3 == 0 { await model.refreshList(.background) }
            }
        }
        .sheet(item: $model.activeSheet) { sheet in
            sheetContent(sheet).preferredColorScheme(.dark)
        }
        .alert(model.confirmation?.title ?? "",
               isPresented: Binding(get: { model.confirmation != nil }, set: { if !$0 { model.confirmation = nil } }),
               presenting: model.confirmation) { confirmation in
            Button("Cancel", role: .cancel) {}
            Button(confirmation.button, role: confirmation.destructive ? .destructive : nil) {
                Task { await confirmation.action() }
            }
        } message: { confirmation in
            Text(confirmation.message)
        }
    }

    @ViewBuilder private func sheetContent(_ sheet: ActiveSheet) -> some View {
        switch sheet {
        case .settings: SettingsSheet(model: model)
        case .newWorkspace: NewWorkspaceSheet(model: model)
        case .addStaff(let workspace): AddStaffSheet(model: model, workspace: workspace)
        case .newRoom(let workspace): NewRoomSheet(model: model, workspace: workspace)
        case .addGithubToken(let workspace, let owner): AddGithubTokenSheet(model: model, workspace: workspace, existing: owner)
        case .freshStart: FreshStartSheet(model: model)
        case .rename(let workspace): RenameSheet(model: model, workspace: workspace)
        case .deleteWorkspace(let workspace): DeleteWorkspaceSheet(model: model, workspace: workspace)
        case .invite(let room): InviteSheet(model: model, room: room)
        case .reveal(let reveal): RevealSheet(model: model, reveal: reveal)
        }
    }

    private var statusLine: some View {
        HStack(spacing: 8) {
            Circle().fill(model.failed ? Palette.red : Palette.mint).frame(width: 6, height: 6)
            Text(model.message)
                .font(.system(size: 11))
                .foregroundStyle(model.failed ? Palette.red : Palette.mint)
                .textSelection(.enabled)
                .lineLimit(2)
                .accessibilityLabel(model.failed ? "Error: \(model.message)" : model.message)
            Spacer(minLength: 12)
            Text("Closing this window leaves the hub running.").font(.system(size: 10)).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(Palette.panel)
    }
}

// MARK: - App

private final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        SecretClipboard.clearIfStillHeld()
        if let text = NSPasteboard.general.string(forType: .string),
           text.range(of: "^ach_[A-Za-z0-9_-]{32}$", options: .regularExpression) != nil {
            NSPasteboard.general.clearContents()
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { sender.windows.first?.makeKeyAndOrderFront(nil) }
        activate(sender)
        return true
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        activate(NSApplication.shared)
    }
    private func activate(_ app: NSApplication) {
        if #available(macOS 14, *) { app.activate() } else { app.activate(ignoringOtherApps: true) }
    }
}

@main
struct CollabHubLauncher: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup("Collab Studio") { StudioView() }
            .windowStyle(.hiddenTitleBar)
            .defaultSize(width: 1100, height: 720)
            .commands { CommandGroup(replacing: .newItem) {} }
    }
}
