import AppKit

enum DebugLog {
    static let enabled = ProcessInfo.processInfo.environment["DIGEST_DEBUG"] == "1"
    static let path = ProcessInfo.processInfo.environment["DIGEST_DEBUG_LOG"] ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/.local/share/daily-agent-digest/tray.debug.log")
    static func write(_ message: String) {
        guard enabled else { return }
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        let url = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: path) {
                let handle = try FileHandle(forWritingTo: url)
                try handle.seekToEnd()
                try handle.write(contentsOf: Data(line.utf8))
                try handle.close()
            } else {
                try Data(line.utf8).write(to: url, options: .atomic)
            }
        } catch { }
    }
}

final class Backend {
    let executable: String
    init() {
        executable = ProcessInfo.processInfo.environment["DIGEST_ENGINE"] ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/.local/share/daily-agent-digest/daily-agent-digest")
        DebugLog.write("backend executable=\(executable)")
    }
    func call(_ command: String, _ input: [String: Any] = [:], completion: @escaping ([String: Any]) -> Void) {
        DebugLog.write("backend call command=\(command) input_keys=\(input.keys.sorted())")
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: self.executable); p.arguments = ["--app-command", command]
            let stdin = Pipe(), stdout = Pipe(); p.standardInput = stdin; p.standardOutput = stdout
            do {
                try p.run()
                stdin.fileHandleForWriting.write((try JSONSerialization.data(withJSONObject: input)))
                stdin.fileHandleForWriting.closeFile()
                let data = stdout.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? ["error": "后端无响应"]
                DebugLog.write("backend result command=\(command) exit=\(p.terminationStatus) bytes=\(data.count) keys=\(obj.keys.sorted()) error=\(obj["error"] ?? "")")
                DispatchQueue.main.async { completion(obj) }
            } catch {
                DebugLog.write("backend launch error command=\(command) error=\(error.localizedDescription)")
                DispatchQueue.main.async { completion(["error": error.localizedDescription]) }
            }
        }
    }
}

final class ReportController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    let backend: Backend
    var items = [[String: Any]]()
    let table = NSTableView()
    let status = NSTextField(labelWithString: "")
    let summary = NSTextView()
    let heading = NSTextField(labelWithString: "今日工作日报")
    let metadata = NSTextField(labelWithString: "")

    init(backend: Backend) {
        self.backend = backend
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 860, height: 660))
        view.autoresizesSubviews = true

        heading.font = NSFont.systemFont(ofSize: 26, weight: .semibold)
        heading.frame = NSRect(x: 28, y: 610, width: 600, height: 34)
        view.addSubview(heading)

        metadata.font = NSFont.systemFont(ofSize: 12)
        metadata.textColor = .secondaryLabelColor
        metadata.frame = NSRect(x: 30, y: 586, width: 800, height: 20)
        view.addSubview(metadata)

        let summaryLabel = NSTextField(labelWithString: "工作总结")
        summaryLabel.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        summaryLabel.frame = NSRect(x: 28, y: 548, width: 200, height: 22)
        view.addSubview(summaryLabel)

        summary.isEditable = false
        summary.isSelectable = true
        summary.isRichText = false
        summary.drawsBackground = true
        summary.backgroundColor = NSColor.controlBackgroundColor
        summary.textContainerInset = NSSize(width: 12, height: 10)
        summary.font = NSFont.systemFont(ofSize: 14)
        summary.frame = NSRect(x: 0, y: 0, width: 780, height: 170)
        let summaryScroll = NSScrollView(frame: NSRect(x: 28, y: 350, width: 804, height: 190))
        summaryScroll.hasVerticalScroller = true
        summaryScroll.borderType = .bezelBorder
        summaryScroll.documentView = summary
        view.addSubview(summaryScroll)

        let itemsLabel = NSTextField(labelWithString: "工作主题")
        itemsLabel.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        itemsLabel.frame = NSRect(x: 28, y: 320, width: 200, height: 22)
        view.addSubview(itemsLabel)

        let tableScroll = NSScrollView(frame: NSRect(x: 28, y: 72, width: 804, height: 245))
        tableScroll.hasVerticalScroller = true
        tableScroll.borderType = .bezelBorder
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("work")))
        table.headerView = nil
        table.frame = tableScroll.bounds
        table.autoresizingMask = [.width, .height]
        tableScroll.documentView = table
        view.addSubview(tableScroll)

        status.font = NSFont.systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.frame = NSRect(x: 28, y: 24, width: 804, height: 24)
        view.addSubview(status)

        let w = NSWindow(contentRect: view.bounds, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        w.contentView = view
        w.minSize = NSSize(width: 720, height: 560)
        w.title = "今日工作日报"
        super.init(window: w)
        table.dataSource = self
        table.delegate = self
        table.rowHeight = 62
        DebugLog.write("report layout window=\(view.frame.width)x\(view.frame.height) summary=\(summary.frame.width)x\(summary.frame.height) table=\(table.frame.width)x\(table.frame.height)")
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }
    func refresh() {
        DebugLog.write("report refresh")
        backend.call("state") { [weak self] obj in
            guard let self = self else { return }
            if let error = obj["error"] as? String { self.status.stringValue = "错误: \(error)"; return }
            self.items = obj["work_items"] as? [[String: Any]] ?? []
            let reportStatus = obj["report_status"] as? String ?? "unknown"
            let day = obj["date"] as? String ?? ""
            let release = obj["release_version"] as? String ?? "unknown"
            let uiBuild = Bundle.main.object(forInfoDictionaryKey: "DigestUIBuildID") as? String ?? "unknown"
            let text = (obj["summary"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self.summary.string = text.isEmpty ? "尚未生成今日总结。请从状态栏菜单选择“生成今日总结”。" : text
            self.metadata.stringValue = "\(day)  ·  \(self.items.count) 个工作主题  ·  状态：\(reportStatus)  ·  引擎：\(release)  ·  UI：\(uiBuild)"
            self.status.stringValue = "可排除主题：点击每行右侧 ×；排除后不会提交到预留接口。"
            DebugLog.write("report state date=\(day) status=\(reportStatus) items=\(self.items.count) summary_chars=\(text.count) engine=\(release) ui=\(uiBuild)")
            self.table.reloadData()
        }
    }
    func numberOfRows(in tableView: NSTableView) -> Int { items.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = items[row]
        let cell = NSTableCellView()
        let title = NSTextField(labelWithString: "\(item["title"] ?? "工作项")")
        title.font = NSFont.boldSystemFont(ofSize: 14)
        title.frame = NSRect(x: 12, y: 34, width: 650, height: 22)
        cell.addSubview(title)
        let details = NSTextField(wrappingLabelWithString: "\(item["details"] ?? "")")
        details.font = NSFont.systemFont(ofSize: 11)
        details.textColor = .secondaryLabelColor
        details.lineBreakMode = .byTruncatingTail
        details.frame = NSRect(x: 12, y: 8, width: 650, height: 22)
        cell.addSubview(details)
        let b = NSButton(title: item["excluded"] as? Bool == true ? "恢复" : "×", target: self, action: #selector(toggle(_:)))
        b.tag = row
        b.toolTip = item["excluded"] as? Bool == true ? "恢复并纳入上报" : "排除这项工作内容"
        b.frame = NSRect(x: 730, y: 18, width: 58, height: 28)
        cell.addSubview(b)
        return cell
    }
    @objc func toggle(_ sender: NSButton) { let item=items[sender.tag]; let excluded=item["excluded"] as? Bool == true; backend.call(excluded ? "restore" : "exclude", ["id":item["id"] as? String ?? ""]) { [weak self] _ in self?.refresh() } }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let backend=Backend(); var statusItem:NSStatusItem!; var report:ReportController!; var timer:Timer!
    func applicationDidFinishLaunching(_ n: Notification) { DebugLog.write("app launch pid=\(ProcessInfo.processInfo.processIdentifier) bundle=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "unknown") ui=\(Bundle.main.object(forInfoDictionaryKey: "DigestUIBuildID") ?? "unknown")"); statusItem=NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength); statusItem.button?.image=NSImage(systemSymbolName:"checklist", accessibilityDescription:"Daily Agent Digest"); let m=NSMenu(); m.addItem(NSMenuItem(title:"查看今日总结", action:#selector(show), keyEquivalent:"")); m.addItem(NSMenuItem(title:"生成今日总结", action:#selector(generate), keyEquivalent:"")); m.addItem(NSMenuItem.separator()); m.addItem(NSMenuItem(title:"设置", action:#selector(settings), keyEquivalent:",")); m.addItem(NSMenuItem(title:"退出", action:#selector(quit), keyEquivalent:"q")); statusItem.menu=m; report=ReportController(backend:backend); timer=Timer.scheduledTimer(withTimeInterval:60,repeats:true){ _ in self.backend.call("tick") { _ in } } }
    @objc func show(){ report.refresh(); report.showWindow(nil); NSApp.activate(ignoringOtherApps:true) }
    @objc func generate(){
        let alert = NSAlert(); alert.messageText = "正在生成今日总结"; alert.informativeText = "正在汇总当天所有 agent 工作记录，请稍候。"; let progress = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 360, height: 20)); progress.style = .bar; progress.isIndeterminate = true; progress.startAnimation(nil); alert.accessoryView = progress; alert.addButton(withTitle: "后台运行"); alert.addButton(withTitle: "取消");
        DispatchQueue.main.async { self.backend.call("clear") { _ in self.backend.call("generate") { result in
            progress.stopAnimation(nil); progress.isIndeterminate = false; progress.doubleValue = 1; alert.accessoryView = nil
            let failed = result["error"] as? String
            alert.messageText = failed == nil ? "今日总结生成成功" : "生成失败"; alert.informativeText = failed ?? "旧的今日总结已替换，可以查看最新内容。"
            alert.buttons.forEach { $0.isHidden = true }
            if failed == nil { let view = alert.addButton(withTitle: "查看今日总结"); view.isHidden = false; view.target = self; view.action = #selector(self.showFromGeneration(_:)) }
            let close = alert.addButton(withTitle: failed == nil ? "关闭" : "确定"); close.isHidden = false
        } } }
        alert.runModal()
    }
    @objc func showFromGeneration(_ sender: NSButton) { NSApp.abortModal(); show() }
    @objc func settings(){
        backend.call("settings") { [weak self] current in
            guard let self = self else { return }
            let alert = NSAlert(); alert.messageText = "日报设置"; alert.informativeText = "修改后立即用于下一次总结。API Key 只在安装时输入。"
            let form = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 118))
            let urlLabel = NSTextField(labelWithString: "Base URL"); urlLabel.frame = NSRect(x: 0, y: 82, width: 100, height: 24)
            let url = NSTextField(string: current["base_url"] as? String ?? "https://api.deepseek.com/v1"); url.frame = NSRect(x: 108, y: 78, width: 312, height: 28)
            let modelLabel = NSTextField(labelWithString: "Model"); modelLabel.frame = NSRect(x: 0, y: 42, width: 100, height: 24)
            let model = NSTextField(string: current["model"] as? String ?? "deepseek-flash"); model.frame = NSRect(x: 108, y: 38, width: 312, height: 28)
            let key = NSTextField(labelWithString: (current["api_key_set"] as? Bool == true) ? "API Key: 已配置" : "API Key: 未配置"); key.textColor = .secondaryLabelColor; key.frame = NSRect(x: 108, y: 4, width: 312, height: 22)
            form.addSubview(urlLabel); form.addSubview(url); form.addSubview(modelLabel); form.addSubview(model); form.addSubview(key)
            alert.accessoryView = form; alert.addButton(withTitle: "取消"); alert.addButton(withTitle: "保存")
            if alert.runModal() == .alertSecondButtonReturn { self.backend.call("save-settings", ["base_url": url.stringValue, "model": model.stringValue]) { result in if let error = result["error"] as? String { let e = NSAlert(); e.messageText = "保存失败"; e.informativeText = error; e.runModal() } } }
        }
    }
    @objc func quit(){ timer.invalidate(); NSApp.terminate(nil) }
}

let app=NSApplication.shared; let delegate=AppDelegate(); app.delegate=delegate; app.setActivationPolicy(.accessory); app.run()
