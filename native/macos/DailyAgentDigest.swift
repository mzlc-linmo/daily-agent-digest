import AppKit

final class Backend {
    let executable: String
    init() { executable = ProcessInfo.processInfo.environment["DIGEST_ENGINE"] ?? (FileManager.default.homeDirectoryForCurrentUser.path + "/.local/share/daily-agent-digest/daily-agent-digest") }
    func call(_ command: String, _ input: [String: Any] = [:], completion: @escaping ([String: Any]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: self.executable); p.arguments = ["--app-command", command]
            let stdin = Pipe(), stdout = Pipe(); p.standardInput = stdin; p.standardOutput = stdout
            do { try p.run(); stdin.fileHandleForWriting.write((try JSONSerialization.data(withJSONObject: input)) ); stdin.fileHandleForWriting.closeFile(); p.waitUntilExit(); let data = stdout.fileHandleForReading.readDataToEndOfFile(); let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? ["error":"后端无响应"]; DispatchQueue.main.async { completion(obj) } }
            catch { DispatchQueue.main.async { completion(["error": error.localizedDescription]) } }
        }
    }
}

final class ReportController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    let backend: Backend; var items = [[String: Any]](); let table = NSTableView(); let status = NSTextField(labelWithString: "")
    init(backend: Backend) { self.backend = backend; let scroll = NSScrollView(frame: .zero); scroll.hasVerticalScroller = true; table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("work"))); table.headerView = nil; scroll.documentView = table; let view = NSView(frame: NSRect(x:0,y:0,width:720,height:430)); scroll.frame = NSRect(x:20,y:65,width:680,height:340); view.addSubview(scroll); status.frame = NSRect(x:20,y:20,width:680,height:30); view.addSubview(status); let w = NSWindow(contentRect: view.bounds, styleMask: [.titled,.closable,.resizable], backing: .buffered, defer: false); w.title = "Daily Agent Digest"; super.init(window:w); table.dataSource=self; table.delegate=self; table.rowHeight=32; refresh() }
    required init?(coder: NSCoder) { fatalError() }
    func refresh() { backend.call("state") { [weak self] obj in self?.items = obj["work_items"] as? [[String: Any]] ?? []; self?.status.stringValue = "日报状态: \(obj["report_status"] as? String ?? "unknown")"; self?.table.reloadData() } }
    func numberOfRows(in tableView: NSTableView) -> Int { items.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? { let item=items[row]; let cell=NSTableCellView(); let title=NSTextField(labelWithString: "\(item["title"] ?? "")"); title.frame=NSRect(x:8,y:5,width:520,height:22); cell.addSubview(title); let b=NSButton(title: item["excluded"] as? Bool == true ? "恢复" : "×", target:self, action:#selector(toggle(_:))); b.tag=row; b.frame=NSRect(x:600,y:2,width:60,height:26); cell.addSubview(b); return cell }
    @objc func toggle(_ sender: NSButton) { let item=items[sender.tag]; let excluded=item["excluded"] as? Bool == true; backend.call(excluded ? "restore" : "exclude", ["id":item["id"] as? String ?? ""]) { [weak self] _ in self?.refresh() } }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let backend=Backend(); var statusItem:NSStatusItem!; var report:ReportController!; var timer:Timer!
    func applicationDidFinishLaunching(_ n: Notification) { statusItem=NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength); statusItem.button?.image=NSImage(systemSymbolName:"checklist", accessibilityDescription:"Daily Agent Digest"); let m=NSMenu(); m.addItem(NSMenuItem(title:"查看今日总结", action:#selector(show), keyEquivalent:"")); m.addItem(NSMenuItem(title:"生成今日总结", action:#selector(generate), keyEquivalent:"")); m.addItem(NSMenuItem.separator()); m.addItem(NSMenuItem(title:"设置", action:#selector(settings), keyEquivalent:",")); m.addItem(NSMenuItem(title:"退出", action:#selector(quit), keyEquivalent:"q")); statusItem.menu=m; report=ReportController(backend:backend); timer=Timer.scheduledTimer(withTimeInterval:60,repeats:true){ _ in self.backend.call("tick") { _ in } } }
    @objc func show(){ report.refresh(); report.showWindow(nil); NSApp.activate(ignoringOtherApps:true) }
    @objc func generate(){ backend.call("generate"){ [weak self] _ in self?.show() } }
    @objc func settings(){ let a=NSAlert(); a.messageText="日报设置"; let u=NSTextField(string: "https://api.deepseek.com/v1"); let model=NSTextField(string:"deepseek-flash"); u.placeholderString="Base URL"; model.placeholderString="Model name"; let box=NSStackView(views:[u,model]); box.orientation=.vertical; box.spacing=8; a.accessoryView=box; a.addButton(withTitle:"保存"); a.addButton(withTitle:"取消"); if a.runModal()==.alertFirstButtonReturn { backend.call("save-settings",["base_url":u.stringValue,"model":model.stringValue]){ _ in } } }
    @objc func quit(){ timer.invalidate(); NSApp.terminate(nil) }
}

let app=NSApplication.shared; let delegate=AppDelegate(); app.delegate=delegate; app.setActivationPolicy(.accessory); app.run()
