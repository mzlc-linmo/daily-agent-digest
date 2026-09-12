import AppKit

final class Backend {
    let executable: String
    init() { executable = ProcessInfo.processInfo.environment["DIGEST_ENGINE"] ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/.local/share/daily-agent-digest/daily-agent-digest") }
    func call(_ command: String, _ input: [String: Any] = [:], completion: @escaping ([String: Any]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: self.executable); p.arguments = ["--app-command", command]
            let stdin = Pipe(), stdout = Pipe(); p.standardInput = stdin; p.standardOutput = stdout
            do { try p.run(); stdin.fileHandleForWriting.write((try JSONSerialization.data(withJSONObject: input)) ); stdin.fileHandleForWriting.closeFile(); let data = stdout.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit(); let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? ["error":"后端无响应"]; DispatchQueue.main.async { completion(obj) } }
            catch { DispatchQueue.main.async { completion(["error": error.localizedDescription]) } }
        }
    }
}

final class ReportController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    let backend: Backend; var items = [[String: Any]](); let table = NSTableView(); let status = NSTextField(labelWithString: ""); let summary = NSTextField(wrappingLabelWithString: "")
    init(backend: Backend) { self.backend = backend; let scroll = NSScrollView(frame: NSRect(x:20,y:115,width:680,height:290)); scroll.hasVerticalScroller = true; table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("work"))); table.headerView = nil; table.frame = scroll.bounds; table.autoresizingMask = [.width, .height]; scroll.documentView = table; let view = NSView(frame: NSRect(x:0,y:0,width:720,height:470)); summary.frame = NSRect(x:20,y:415,width:680,height:45); view.addSubview(summary); view.addSubview(scroll); status.frame = NSRect(x:20,y:20,width:680,height:30); view.addSubview(status); let w = NSWindow(contentRect: view.bounds, styleMask: [.titled,.closable,.resizable], backing: .buffered, defer: false); w.contentView = view; w.title = "Daily Agent Digest"; super.init(window:w); table.dataSource=self; table.delegate=self; table.rowHeight=54; refresh() }
    required init?(coder: NSCoder) { fatalError() }
    func refresh() { backend.call("state") { [weak self] obj in guard let self = self else { return }; if let error = obj["error"] as? String { self.status.stringValue = "错误: \(error)"; return }; self.items = obj["work_items"] as? [[String: Any]] ?? []; self.summary.stringValue = obj["summary"] as? String ?? "尚未生成总结"; self.status.stringValue = "日报状态: \(obj["report_status"] as? String ?? "unknown") · \(self.items.count) 项"; self.table.reloadData() } }
    func numberOfRows(in tableView: NSTableView) -> Int { items.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? { let item=items[row]; let cell=NSTableCellView(); let title=NSTextField(labelWithString: "\(item["title"] ?? "工作项")"); title.font=NSFont.boldSystemFont(ofSize: 14); title.frame=NSRect(x:8,y:28,width:540,height:22); cell.addSubview(title); let details=NSTextField(wrappingLabelWithString: "\(item["details"] ?? "")"); details.font=NSFont.systemFont(ofSize: 11); details.textColor = .secondaryLabelColor; details.frame=NSRect(x:8,y:4,width:540,height:22); cell.addSubview(details); let b=NSButton(title: item["excluded"] as? Bool == true ? "恢复" : "×", target:self, action:#selector(toggle(_:))); b.tag=row; b.frame=NSRect(x:600,y:14,width:60,height:26); cell.addSubview(b); return cell }
    @objc func toggle(_ sender: NSButton) { let item=items[sender.tag]; let excluded=item["excluded"] as? Bool == true; backend.call(excluded ? "restore" : "exclude", ["id":item["id"] as? String ?? ""]) { [weak self] _ in self?.refresh() } }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let backend=Backend(); var statusItem:NSStatusItem!; var report:ReportController!; var timer:Timer!
    func applicationDidFinishLaunching(_ n: Notification) { statusItem=NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength); statusItem.button?.image=NSImage(systemSymbolName:"checklist", accessibilityDescription:"Daily Agent Digest"); let m=NSMenu(); m.addItem(NSMenuItem(title:"查看今日总结", action:#selector(show), keyEquivalent:"")); m.addItem(NSMenuItem(title:"生成今日总结", action:#selector(generate), keyEquivalent:"")); m.addItem(NSMenuItem.separator()); m.addItem(NSMenuItem(title:"设置", action:#selector(settings), keyEquivalent:",")); m.addItem(NSMenuItem(title:"退出", action:#selector(quit), keyEquivalent:"q")); statusItem.menu=m; report=ReportController(backend:backend); timer=Timer.scheduledTimer(withTimeInterval:60,repeats:true){ _ in self.backend.call("tick") { _ in } } }
    @objc func show(){ report.refresh(); report.showWindow(nil); NSApp.activate(ignoringOtherApps:true) }
    @objc func generate(){
        let alert = NSAlert(); alert.messageText = "正在生成今日总结"; alert.informativeText = "正在汇总当天所有 agent 工作记录，请稍候。"; let progress = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 360, height: 20)); progress.style = .bar; progress.isIndeterminate = true; progress.startAnimation(nil); alert.accessoryView = progress; alert.addButton(withTitle: "后台运行"); alert.addButton(withTitle: "取消");
        DispatchQueue.main.async { self.backend.call("clear") { _ in self.backend.call("generate") { result in
            progress.stopAnimation(nil); progress.isIndeterminate = false; progress.doubleValue = 1
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
