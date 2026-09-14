import AppKit
import ServiceManagement

/// 应用数据目录的唯一来源,必须和引擎的 `APP_DIR` 默认值一致
/// (`DIGEST_HOME`,否则 `~/Library/Application Support/Daily Agent Digest`)。
/// 这里曾经有三份各自硬编码的 `~/.local/share/daily-agent-digest`:
/// 引擎配置目录迁走之后,它们会让界面显示一个并不存放配置的目录。
enum DigestPaths {
    static let dataDirectory: String = ProcessInfo.processInfo.environment["DIGEST_HOME"]
        ?? FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/Daily Agent Digest"
}

enum DebugLog {
    static let enabled = ProcessInfo.processInfo.environment["DIGEST_DEBUG"] == "1"
    static let path = ProcessInfo.processInfo.environment["DIGEST_DEBUG_LOG"] ?? (DigestPaths.dataDirectory + "/tray.debug.log")
    /// 日志里可能出现上游错误体(含 token 片段),落盘前先脱敏。
    static func redact(_ text: String) -> String {
        var out = text
        for pattern in ["(dag_[A-Za-z0-9_\\-]{6})[A-Za-z0-9_\\-]+", "(Bearer\\s+)[A-Za-z0-9._\\-]+"] {
            out = out.replacingOccurrences(of: pattern, with: "$1**", options: .regularExpression)
        }
        return out
    }

    /// 串行队列:引擎调用都在后台线程,并发 seekToEnd+write 会互相覆盖。
    private static let queue = DispatchQueue(label: "digest.debuglog")

    static func write(_ message: String) {
        guard enabled else { return }
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(redact(message))\n"
        queue.async {
            let url = URL(fileURLWithPath: path)
            do {
                // 目录 0700、文件 0600:与 .env / state.json 一致 —— 日志里可能有敏感文本
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
                if FileManager.default.fileExists(atPath: path) {
                    let handle = try FileHandle(forWritingTo: url)
                    defer { try? handle.close() }
                    try handle.seekToEnd()
                    try handle.write(contentsOf: Data(line.utf8))
                } else {
                    try Data(line.utf8).write(to: url, options: .atomic)
                }
                try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
            } catch { }
        }
    }
}

final class Flag {
    private let lock = NSLock()
    private var value = false
    func raise() { lock.lock(); value = true; lock.unlock() }
    var isRaised: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

final class Backend {
    let executable: String
    static let defaultTimeout: TimeInterval = 60
    static let generateTimeout: TimeInterval = 600
    init() {
        // 优先用 App 包内的 onedir 引擎:它随包分发、启动无需解包,是发布版的默认布局。
        // 发布版此前装的是 PyInstaller onefile,每次调用都要把 20MB 解开再重新 exec 自己,
        // 单次启动实测 3-6 秒,而窗口/菜单动作每次都要新起一个进程。
        // 其后是历史布局(onefile 放在 Resources 或 MacOS)、开发版环境变量,
        // 最后是 install.sh 的布局:引擎装在数据目录里。
        let bundleRoot = Bundle.main.bundleURL
        let bundledCandidates = [
            bundleRoot.appendingPathComponent("Contents/Resources/engine/daily-agent-digest").path,
            bundleRoot.appendingPathComponent("Contents/Resources/daily-agent-digest").path,
            bundleRoot.appendingPathComponent("Contents/MacOS/daily-agent-digest").path,
        ]
        executable = ProcessInfo.processInfo.environment["DIGEST_ENGINE"]
            ?? bundledCandidates.first { FileManager.default.isExecutableFile(atPath: $0) }
            ?? DigestPaths.dataDirectory + "/daily-agent-digest"
        DebugLog.write("backend executable=\(executable)")
    }
    func call(_ command: String, _ input: [String: Any] = [:], timeout: TimeInterval = Backend.defaultTimeout, completion: @escaping ([String: Any]) -> Void) {
        DebugLog.write("backend call command=\(command) input_keys=\(input.keys.sorted()) timeout=\(Int(timeout))s")
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: self.executable); p.arguments = ["--app-command", command]
            let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
            p.standardInput = stdin; p.standardOutput = stdout; p.standardError = stderr
            let timedOut = Flag()
            do {
                try p.run()
                stdin.fileHandleForWriting.write((try JSONSerialization.data(withJSONObject: input)))
                stdin.fileHandleForWriting.closeFile()
                // Watchdog: a stuck engine must never freeze the UI forever.
                let watchdog = DispatchWorkItem {
                    if p.isRunning { timedOut.raise(); p.terminate() }
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
                let data = stdout.fileHandleForReading.readDataToEndOfFile()
                let errData = stderr.fileHandleForReading.readDataToEndOfFile()
                p.waitUntilExit()
                watchdog.cancel()
                let stderrText = (String(data: errData, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
                if obj.isEmpty {
                    obj["error"] = timedOut.isRaised ? "引擎在 \(Int(timeout)) 秒内没有响应" : (stderrText.isEmpty ? "后端无响应" : stderrText)
                } else if p.terminationStatus != 0 && obj["error"] == nil {
                    obj["error"] = stderrText.isEmpty ? "引擎以退出码 \(p.terminationStatus) 结束" : stderrText
                }
                if !stderrText.isEmpty { obj["_stderr"] = stderrText }
                DebugLog.write("backend result command=\(command) exit=\(p.terminationStatus) timedOut=\(timedOut.isRaised) bytes=\(data.count) keys=\(obj.keys.sorted()) error=\(obj["error"] ?? "") stderr=\(stderrText.prefix(200))")
                DispatchQueue.main.async { completion(obj) }
            } catch {
                DebugLog.write("backend launch error command=\(command) error=\(error.localizedDescription)")
                DispatchQueue.main.async { completion(["error": error.localizedDescription]) }
            }
        }
    }
    /// The engine reports a failed generation as an `error` key, a non-empty
    /// `last_error`, or `report_status == "error"` while still exiting 0, so a
    /// missing `error` key alone must never be read as success.
    /// Returns nil when the generation succeeded, otherwise the reason.
    static func failureReason(_ state: [String: Any]) -> String? {
        if let error = state["error"] as? String, !error.isEmpty { return error }
        let status = state["report_status"] as? String ?? ""
        if let last = state["last_error"] as? String, !last.isEmpty { return last }
        if status == "error" { return "引擎报告生成失败" }
        if status == "ready" || status == "submitted" { return nil }
        return "生成没有返回可用状态(report_status=\(status.isEmpty ? "unknown" : status))"
    }
}

final class ReportController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    let backend: Backend
    var items = [[String: Any]]()
    let table = NSTableView()
    let status = NSTextField(labelWithString: "")
    let upload = NSButton(title: "上传", target: nil, action: nil)
    /// 把当日日报导出成 Markdown 文档(可复制 / 保存)。
    let markdown = NSButton(title: "Markdown", target: nil, action: nil)
    let summary = NSTextView()
    let heading = NSTextField(labelWithString: "今日工作日报")
    let metadata = NSTextField(labelWithString: "")
    let summaryScroll = NSScrollView()
    let summaryLabel = NSTextField(labelWithString: "工作总结")
    let itemsLabel = NSTextField(labelWithString: "工作主题")
    let tableScroll = NSScrollView()
    // Kept so an exclusion can re-render the document immediately: removing an
    // item is an array filter, not a regeneration.
    var stateDay = ""
    var stateStatus = "unknown"
    var stateRelease = "unknown"
    var stateUIBuild = "unknown"
    var stateChars = 0
    /// 引擎给出的"这份日报为什么可能不完整"(未归并、缺 zstd、采集器报错…)。
    /// 以前这些只躺在 state 里,界面不显示,于是缺来源/没归并的报告看起来完全正常。
    var stateWarnings: [String] = []
    let warning = NSTextField(labelWithString: "")
    static let warningFont = NSFont.systemFont(ofSize: 12)
    /// Markdown 文档面板(非模态:可以一边看文档一边在报告窗口里排除条目后重新导出)
    var markdownPanel: NSPanel?
    var markdownView: NSTextView?
    var markdownStatus: NSTextField?
    /// Must match REPORT_CHAR_LIMIT in daily_agent_digest.py; shown so the
    /// documented report length is visible while reading.
    static let reportCharLimit = 1000

    init(backend: Backend) {
        self.backend = backend
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 880, height: 900))
        view.autoresizesSubviews = true

        heading.font = NSFont.systemFont(ofSize: 26, weight: .semibold)
        view.addSubview(heading)

        metadata.font = NSFont.systemFont(ofSize: 12)
        metadata.textColor = .secondaryLabelColor
        view.addSubview(metadata)

        summaryLabel.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        view.addSubview(summaryLabel)

        summary.isEditable = false
        summary.isSelectable = true
        summary.isRichText = true
        summary.drawsBackground = true
        summary.backgroundColor = NSColor.controlBackgroundColor
        summary.textContainerInset = NSSize(width: 12, height: 10)
        summary.font = NSFont.systemFont(ofSize: 14)
        summary.frame = NSRect(x: 0, y: 0, width: 780, height: 90)
        summaryScroll.hasVerticalScroller = true
        summaryScroll.borderType = .bezelBorder
        summaryScroll.documentView = summary
        view.addSubview(summaryScroll)

        itemsLabel.font = NSFont.systemFont(ofSize: 14, weight: .semibold)
        view.addSubview(itemsLabel)

        tableScroll.hasVerticalScroller = true
        tableScroll.borderType = .bezelBorder
        table.headerView = nil
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("work")))
        table.frame = tableScroll.bounds
        table.autoresizingMask = [.width, .height]
        // Row heights and cell frames are both derived from one column width,
        // measured with the text engine, so they can never disagree. AppKit's
        // automatic row heights are deliberately not used: with a single column
        // they interact badly with column sizing and left the cell at half width.
        table.usesAutomaticRowHeights = false
        table.columnAutoresizingStyle = .noColumnAutoresizing
        table.rowHeight = 34
        table.intercellSpacing = NSSize(width: 0, height: 4)
        tableScroll.documentView = table
        view.addSubview(tableScroll)

        warning.font = ReportController.warningFont
        warning.textColor = .systemOrange
        warning.lineBreakMode = .byWordWrapping
        warning.maximumNumberOfLines = 4
        view.addSubview(warning)

        status.font = NSFont.systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.frame = NSRect(x: 28, y: 24, width: 804, height: 24)
        view.addSubview(status)
        view.addSubview(upload)
        view.addSubview(markdown)

        let w = NSWindow(contentRect: view.bounds, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        w.contentView = view
        w.minSize = NSSize(width: 760, height: 620)
        w.title = "今日工作日报"
        super.init(window: w)
        upload.target = self; upload.action = #selector(submitNow)
        upload.bezelStyle = .rounded
        markdown.target = self; markdown.action = #selector(showMarkdown)
        markdown.bezelStyle = .rounded
        markdown.toolTip = "把当日日报显示为 Markdown 文档,可复制或保存为 .md"
        table.dataSource = self
        table.delegate = self
        w.delegate = self
        DebugLog.write("report layout window=\(view.frame.width)x\(view.frame.height) summary=\(summaryScroll.frame.width)x\(summaryScroll.frame.height) table=\(tableScroll.frame.width)x\(tableScroll.frame.height)")
        refresh()
    }
    required init?(coder: NSCoder) { fatalError() }
    func refresh() {
        DebugLog.write("report refresh")
        backend.call("state") { [weak self] obj in
            guard let self = self else { return }
            if let error = obj["error"] as? String {
                // 早退也必须走一次布局:子视图的 frame 只在 relayout() 里设置,
                // 否则引擎不可用时窗口里除左下角一行字外全是 0×0。
                self.status.stringValue = "错误: \(error)"
                self.items = []
                self.stateChars = 0
                self.table.reloadData()
                self.relayout()
                return
            }
            self.items = obj["work_items"] as? [[String: Any]] ?? []
            self.stateStatus = obj["report_status"] as? String ?? "unknown"
            self.stateDay = obj["date"] as? String ?? ""
            self.stateRelease = obj["release_version"] as? String ?? "unknown"
            self.stateUIBuild = Bundle.main.object(forInfoDictionaryKey: "DigestUIBuildID") as? String ?? "unknown"
            self.stateChars = obj["report_chars"] as? Int ?? ReportController.includedChars(items: self.items)
            self.stateWarnings = (obj["warnings"] as? [String]) ?? []
            self.updateWarning()
            self.renderSummary()
            self.updateMetadata()
            // 选材说明必须可见:否则"今天的日报怎么这么少"无从判断。
            let coverage = obj["coverage_note"] as? String ?? ""
            self.status.stringValue = coverage.isEmpty
                ? "工作主题是索引：点击右侧 × 可把该项的标题与内容从上面的工作总结中移除，恢复即可还原。"
                : coverage
            self.relayout()
            DebugLog.write("report state date=\(self.stateDay) status=\(self.stateStatus) items=\(self.items.count) report_chars=\(self.stateChars) engine=\(self.stateRelease) ui=\(self.stateUIBuild)")
            self.syncColumnWidth()
            self.table.reloadData()
            self.syncColumnWidth()
            DebugLog.write("report geometry table=\(Int(self.table.bounds.width)) column=\(Int(self.table.tableColumns.first?.width ?? -1)) body=\(Int(self.bodyWidth())) rows=\(self.items.count)")
        }
    }

    /// The report body is the included work items themselves: one heading plus
    /// its own description per item. Excluding an item removes exactly one block,
    /// with no LLM call and no rewriting of the remaining text.
    static func composeDocument(items: [[String: Any]],
                                empty: String = "尚未生成今日总结。请从状态栏菜单选择“生成今日总结”。") -> NSAttributedString {
        guard !items.isEmpty else {
            return NSAttributedString(string: empty, attributes: [
                .font: NSFont.systemFont(ofSize: 14),
                .foregroundColor: NSColor.secondaryLabelColor,
            ])
        }
        let included = items.filter { ($0["excluded"] as? Bool) != true }
        guard !included.isEmpty else {
            return NSAttributedString(string: "所有工作主题都已被排除，这份日报没有可上报的内容。", attributes: [
                .font: NSFont.systemFont(ofSize: 14),
                .foregroundColor: NSColor.systemOrange,
            ])
        }
        let document = NSMutableAttributedString()
        for (index, item) in included.enumerated() {
            if index > 0 { document.append(NSAttributedString(string: "\n")) }
            let title = (item["title"] as? String) ?? "工作项"
            let desc = (item["desc"] as? String) ?? ""
            document.append(NSAttributedString(string: title + "\n", attributes: [
                .font: NSFont.boldSystemFont(ofSize: 15),
                .foregroundColor: NSColor.labelColor,
            ]))
            if !desc.isEmpty {
                document.append(NSAttributedString(string: desc + "\n", attributes: [
                    .font: NSFont.systemFont(ofSize: 13),
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]))
            }
        }
        return document
    }

    /// Non-whitespace character count of the items that will be reported.
    static func includedChars(items: [[String: Any]]) -> Int {
        items.filter { ($0["excluded"] as? Bool) != true }.reduce(0) { total, item in
            func count(_ text: String) -> Int { text.filter { !$0.isWhitespace }.count }
            return total + count(item["title"] as? String ?? "") + count(item["desc"] as? String ?? "")
        }
    }

    func composedSummary() -> NSAttributedString {
        ReportController.composeDocument(items: items)
    }

    func renderSummary() {
        summary.textStorage?.setAttributedString(composedSummary())
    }

    func updateMetadata() {
        let excluded = items.filter { ($0["excluded"] as? Bool) == true }.count
        var line = "\(stateDay)  ·  共 \(items.count) 项"
        if excluded > 0 { line += "（已排除 \(excluded) 项）" }
        line += "  ·  计入上报 \(stateChars) 字 / 上限 \(ReportController.reportCharLimit) 字"
        line += "  ·  状态：\(stateStatus)  ·  引擎：\(stateRelease)  ·  UI：\(stateUIBuild)"
        metadata.stringValue = line
    }

    /// The summary is the body of the report, so the area it gets is derived
    /// from the text it actually holds: it grows until the whole summary is
    /// visible and only then lets the work-item list scroll.
    func summaryTextHeight(boxWidth: CGFloat) -> CGFloat {
        let inset = summary.textContainerInset
        let width = max(200, boxWidth - 2 * inset.width - 4)
        return ReportController.textHeight(composedSummary(), width: width) + 2 * inset.height + 6
    }

    func relayout() {
        guard let view = window?.contentView else { return }
        let pad: CGFloat = 28
        let width = view.bounds.width - 2 * pad
        guard width > 100 else { return }
        let top = view.bounds.height
        let boxWidth = width

        heading.frame = NSRect(x: pad, y: top - 50, width: width, height: 34)
        metadata.frame = NSRect(x: pad + 2, y: top - 78, width: width, height: 20)

        // 有告警时:告警块接在元信息下面,其余内容整体下移同样的高度,
        // 这样不会与工作总结区重叠(布局是绝对定位)。
        let warnHeight = warningHeight(boxWidth: boxWidth)
        let shift = warnHeight > 0 ? warnHeight + 8 : 0
        warning.frame = NSRect(x: pad + 2, y: top - 84 - warnHeight, width: width, height: warnHeight)

        summaryLabel.frame = NSRect(x: pad, y: top - 112 - shift, width: 200, height: 22)

        let needed = summaryTextHeight(boxWidth: boxWidth)
        let available = max(120, top - 112 - shift - 22 - 40 - 72 - 60)
        let boxHeight = min(max(needed, 120), available)
        let boxTop = top - 118 - shift
        summaryScroll.frame = NSRect(x: pad, y: boxTop - boxHeight, width: boxWidth, height: boxHeight)
        summary.frame = NSRect(x: 0, y: 0, width: boxWidth - 2, height: max(needed, boxHeight))

        itemsLabel.frame = NSRect(x: pad, y: summaryScroll.frame.minY - 30, width: 200, height: 22)
        tableScroll.frame = NSRect(x: pad, y: 72, width: boxWidth, height: max(60, itemsLabel.frame.minY - 12 - 72))
        status.frame = NSRect(x: pad, y: 24, width: boxWidth - 200, height: 24)
        upload.frame = NSRect(x: pad + boxWidth - 80, y: 22, width: 80, height: 26)
        markdown.frame = NSRect(x: pad + boxWidth - 80 - 8 - 96, y: 22, width: 96, height: 26)
        DebugLog.write("report relayout summaryNeeded=\(Int(needed)) summaryBox=\(Int(boxHeight)) table=\(Int(tableScroll.frame.width))x\(Int(tableScroll.frame.height)) items=\(items.count)")
    }
    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    /// Height of `text` when wrapped into `width`.
    ///
    /// Measured with NSLayoutManager, which is the same engine the label uses.
    /// NSAttributedString.boundingRect under-measures long unwrapped CJK runs
    /// (it treats a run without spaces as unbreakable), which previously made
    /// the row too short and silently clipped the body.
    static func textHeight(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        return textHeight(NSAttributedString(string: text, attributes: [.font: font]), width: width)
    }

    /// Height of an attributed string when wrapped into `width`.
    static func textHeight(_ attributed: NSAttributedString, width: CGFloat) -> CGFloat {
        guard attributed.length > 0 else { return 0 }
        let storage = NSTextStorage(attributedString: attributed)
        let container = NSTextContainer(size: NSSize(width: max(60, width), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.lineBreakMode = .byWordWrapping
        let manager = NSLayoutManager()
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        return ceil(manager.usedRect(for: container).height) + 2
    }

    /// Diagnostic helper used by --self-test to show what boundingRect reports.
    static func boundingRectHeight(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
        let attributed = NSAttributedString(string: text, attributes: [.font: font])
        return ceil(attributed.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude),
                                            options: [.usesLineFragmentOrigin, .usesFontLeading]).height)
    }

    static let pad: CGFloat = 12
    static let buttonWidth: CGFloat = 54
    static let charCountWidth: CGFloat = 50

    /// The one width every row and cell is laid out from. Taken from the scroll
    /// view rather than the table so it is correct before the table is resized.
    func contentWidth() -> CGFloat {
        let width = table.enclosingScrollView?.contentSize.width ?? table.bounds.width
        return max(320, width - table.intercellSpacing.width)
    }

    func bodyWidth() -> CGFloat { contentWidth() - 2 * ReportController.pad }

    func titleWidth() -> CGFloat {
        max(120, bodyWidth() - ReportController.charCountWidth - ReportController.buttonWidth - 16)
    }

    /// The list is an index of every work item with its exclusion switch; the
    /// body itself is rendered in the document above, so rows stay compact.
    func rowHeight(for row: Int) -> CGFloat {
        guard row >= 0 && row < items.count else { return 34 }
        let title = items[row]["title"] as? String ?? ""
        let titleH = max(19, ReportController.textHeight(title, font: .boldSystemFont(ofSize: 13), width: titleWidth()))
        return ReportController.pad + titleH + ReportController.pad * 0.6
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { rowHeight(for: row) }

    /// Keep the single column exactly as wide as the table, otherwise the cells
    /// are laid out into a default-width (~100pt) column.
    func syncColumnWidth() {
        let width = contentWidth()
        guard let column = table.tableColumns.first else { return }
        if abs(column.width - width) > 0.5 { column.width = width }
    }

    func windowDidResize(_ notification: Notification) {
        relayout()
        syncColumnWidth()
        guard !items.isEmpty else { return }
        table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<items.count))
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = items[row]
        let cell = NSTableCellView()
        let height = rowHeight(for: row)
        let width = contentWidth()
        let pad = ReportController.pad
        let titleH = max(19, ReportController.textHeight(item["title"] as? String ?? "", font: .boldSystemFont(ofSize: 13), width: titleWidth()))

        let excluded = item["excluded"] as? Bool == true
        let title = NSTextField(wrappingLabelWithString: "\(item["title"] ?? "工作项")")
        title.font = NSFont.boldSystemFont(ofSize: 13)
        title.textColor = excluded ? .tertiaryLabelColor : .labelColor
        title.maximumNumberOfLines = 1
        title.frame = NSRect(x: pad, y: (height - titleH) / 2, width: titleWidth(), height: titleH)
        cell.addSubview(title)

        let state = NSTextField(labelWithString: excluded ? "已排除" : "\(item["chars"] as? Int ?? 0) 字")
        state.font = NSFont.systemFont(ofSize: 10)
        state.textColor = excluded ? .systemOrange : .tertiaryLabelColor
        state.alignment = .right
        state.frame = NSRect(x: width - pad - ReportController.buttonWidth - ReportController.charCountWidth,
                             y: (height - 14) / 2, width: ReportController.charCountWidth, height: 14)
        cell.addSubview(state)

        let b = NSButton(title: excluded ? "恢复" : "×", target: self, action: #selector(toggle(_:)))
        b.tag = row
        b.toolTip = excluded ? "恢复并纳入上报" : "把这一项的标题与内容从工作总结中移除"
        b.frame = NSRect(x: width - pad - ReportController.buttonWidth, y: (height - 26) / 2,
                         width: ReportController.buttonWidth, height: 26)
        cell.addSubview(b)
        return cell
    }

    /// 单条正文的字数:优先用引擎算好的 `chars`,没有就按描述长度兜底。
    static func itemChars(_ item: [String: Any]) -> Int {
        if let chars = item["chars"] as? Int { return chars }
        return (item["desc"] as? String ?? "").count
    }

    /// 把当日日报渲染成 Markdown 文档。
    ///
    /// 只包含**未排除**的条目,所以文档与报告窗口里看到的始终一致;
    /// 排除是纯数组过滤,这里不需要(也不应该)再问一次 LLM。
    static func markdownDocument(items: [[String: Any]], day: String, warnings: [String] = []) -> String {
        let included = items.filter { ($0["excluded"] as? Bool) != true }
        var lines: [String] = ["# 今日工作日报 · \(day.isEmpty ? "未知日期" : day)", ""]
        // 告警必须写进文档本身:导出的 Markdown 常常被直接转发出去,
        // 不能让"未归并/缺来源"的报告看起来像一份完成的总结。
        for text in warnings {
            lines.append("> ⚠️ \(text)")
        }
        if !warnings.isEmpty { lines.append("") }
        if included.isEmpty {
            lines.append("_今天没有计入的条目。_")
            lines.append("")
        } else {
            for (index, item) in included.enumerated() {
                let title = (item["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let desc = (item["desc"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                lines.append("## \(index + 1). \(title.isEmpty ? "(无标题)" : title)")
                lines.append("")
                if !desc.isEmpty {
                    lines.append(desc)
                    lines.append("")
                }
            }
        }
        lines.append("---")
        lines.append("")
        lines.append("- 日期:\(day.isEmpty ? "未知" : day)")
        lines.append("- 工作项:\(included.count) 项")
        lines.append("- 正文合计:\(included.reduce(0) { $0 + itemChars($1) }) 字")
        return lines.joined(separator: "\n") + "\n"
    }

    /// 打开(或刷新)Markdown 文档面板。
    @objc func showMarkdown() {
        let document = ReportController.markdownDocument(items: items, day: stateDay, warnings: stateWarnings)
        if let panel = markdownPanel, let text = markdownView {
            text.string = document
            markdownStatus?.stringValue = "已按当前条目重新生成(\(document.count) 字)"
            markdownStatus?.textColor = .secondaryLabelColor
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let width: CGFloat = 700, height: CGFloat = 560
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "日报 Markdown"
        panel.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))

        let scroll = NSScrollView(frame: NSRect(x: 16, y: 62, width: width - 32, height: height - 78))
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width, .height]
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: width - 32, height: height - 78))
        text.string = document
        text.isEditable = false            // 只读:这是导出结果,不是编辑器
        text.isSelectable = true
        text.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        text.autoresizingMask = [.width]
        text.textContainerInset = NSSize(width: 8, height: 8)
        scroll.documentView = text
        content.addSubview(scroll)

        let statusLabel = NSTextField(labelWithString: "Markdown 源码,可直接选中复制,或点「复制」「保存为 .md…」")
        statusLabel.frame = NSRect(x: 16, y: 34, width: width - 300, height: 20)
        statusLabel.font = NSFont.systemFont(ofSize: 12)
        statusLabel.textColor = .secondaryLabelColor
        content.addSubview(statusLabel)

        func addButton(_ title: String, _ action: Selector, _ x: CGFloat, _ w: CGFloat) {
            let b = NSButton(title: title, target: self, action: action)
            b.frame = NSRect(x: x, y: 30, width: w, height: 28)
            b.bezelStyle = .rounded
            content.addSubview(b)
        }
        addButton("复制", #selector(copyMarkdown), width - 16 - 76 - 8 - 120 - 8 - 76, 76)
        addButton("保存为 .md…", #selector(saveMarkdown), width - 16 - 76 - 8 - 120, 120)
        addButton("关闭", #selector(closeMarkdownPanel), width - 16 - 76, 76)

        panel.contentView = content
        markdownPanel = panel
        markdownView = text
        markdownStatus = statusLabel
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DebugLog.write("markdown panel shown chars=\(document.count) items=\(items.count)")
    }

    @objc func copyMarkdown() {
        let document = markdownView?.string ?? ReportController.markdownDocument(items: items, day: stateDay, warnings: stateWarnings)
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(document, forType: .string)
        markdownStatus?.stringValue = "已复制到剪贴板(\(document.count) 字)"
        markdownStatus?.textColor = .systemGreen
    }

    @objc func saveMarkdown() {
        let document = markdownView?.string ?? ReportController.markdownDocument(items: items, day: stateDay, warnings: stateWarnings)
        let save = NSSavePanel()
        save.nameFieldStringValue = "日报-\(stateDay.isEmpty ? "未生成" : stateDay).md"
        save.canCreateDirectories = true
        save.begin { [weak self] response in
            guard let self = self, response == .OK, let url = save.url else { return }
            do {
                try document.write(to: url, atomically: true, encoding: .utf8)
                self.markdownStatus?.stringValue = "已保存:\(url.path)"
                self.markdownStatus?.textColor = .systemGreen
                DebugLog.write("markdown saved path=\(url.path) chars=\(document.count)")
            } catch {
                self.markdownStatus?.stringValue = "保存失败:\(error.localizedDescription)"
                self.markdownStatus?.textColor = .systemRed
            }
        }
    }

    @objc func closeMarkdownPanel() {
        markdownPanel?.close()
        markdownPanel = nil
        markdownView = nil
        markdownStatus = nil
    }

    /// 告警文本:最多显示 3 条,避免把报告挤出窗口;完整的仍会写进 Markdown。
    func warningText() -> String {
        guard !stateWarnings.isEmpty else { return "" }
        let shown = stateWarnings.prefix(3).map { "⚠️ " + $0 }
        var lines = Array(shown)
        if stateWarnings.count > 3 { lines.append("⚠️ 另有 \(stateWarnings.count - 3) 条提示,详见 Markdown 文档") }
        return lines.joined(separator: "\n")
    }

    func warningHeight(boxWidth: CGFloat) -> CGFloat {
        let text = warningText()
        guard !text.isEmpty else { return 0 }
        return ReportController.textHeight(text, font: ReportController.warningFont, width: boxWidth - 4)
    }

    func updateWarning() {
        warning.stringValue = warningText()
        DebugLog.write("report warnings=\(stateWarnings.count)")
    }

    /// 手动上传:把当前日报提交到服务端(定时任务之外的手动入口)。
    @objc func submitNow() {
        upload.isEnabled = false
        status.stringValue = "正在上传…"
        status.textColor = .secondaryLabelColor
        backend.call("submit", [:], timeout: 120) { [weak self] state in
            guard let self = self else { return }
            self.upload.isEnabled = true
            if let error = state["error"] as? String {
                self.status.stringValue = "上传失败：\(error)"
                self.status.textColor = .systemRed
            } else if state["submit_status"] as? String == "submitted" {
                let mode = state["submit_mode"] as? String ?? "ok"
                let count = state["submitted_count"] as? Int ?? 0
                self.status.stringValue = "已上传（\(mode)）：\(count) 项。再次上传会覆盖当天内容。"
                self.status.textColor = .systemGreen
            } else {
                let reason = state["submit_error"] as? String ?? "未配置提交地址或 API Key"
                self.status.stringValue = "未上传：\(reason)"
                self.status.textColor = .systemRed
            }
            self.refresh()
        }
    }

    @objc func toggle(_ sender: NSButton) {
        let row = sender.tag
        guard row >= 0 && row < items.count else { return }
        let wasExcluded = items[row]["excluded"] as? Bool == true
        let id = items[row]["id"] as? String ?? ""
        // Removing an item is a pure array filter, so the document can be rebuilt
        // synchronously - the backend call only persists the flag.
        items[row]["excluded"] = !wasExcluded
        stateChars = ReportController.includedChars(items: items)
        renderSummary()
        updateMetadata()
        table.reloadData()
        relayout()
        DebugLog.write("exclude toggle id=\(id) nowExcluded=\(!wasExcluded) excludedTotal=\(items.filter { ($0["excluded"] as? Bool) == true }.count) reportChars=\(stateChars)")
        backend.call(wasExcluded ? "restore" : "exclude", ["id": id]) { [weak self] obj in
            guard let self = self else { return }
            if let error = obj["error"] as? String {
                self.status.stringValue = "操作失败：\(error)"
                self.refresh()
            } else {
                self.status.stringValue = wasExcluded
                    ? "已恢复该主题，其内容已回到工作总结。"
                    : "已排除该主题，其标题与内容已从工作总结中移除。"
                // 排除了内容 = 报告变了:让自动 tick 重新生效,当天 18:00 后会自动重新提交
                NotificationCenter.default.post(name: .digestReportChanged, object: nil)
            }
        }
    }
}

extension Notification.Name {
    /// 报告内容发生变化(排除/恢复/重新生成),用于重新放开自动 tick。
    static let digestReportChanged = Notification.Name("digestReportChanged")
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    let backend=Backend(); var statusItem:NSStatusItem!; var report:ReportController!; var timer:Timer!; var progressPanel:NSPanel?; var generationBackgrounded=false
    /// 「开机自启」菜单项:用对勾显示当前是否已开启。
    var loginItemMenuItem:NSMenuItem!
    /// 自动 tick 的节流状态:上一次真正调用引擎的时间,以及已确认提交成功的日期。
    var lastTickAt:Date?; var submittedTickDay:String?

    /// 自动窗口:17:30 之前什么都不用做(引擎自己也是这个门限)。
    static let tickWindowStartMinute = 17 * 60 + 30
    /// 未提交成功时最短重试间隔:失败/未配置都可以再试,但不再每分钟一次。
    static let tickRetryInterval: TimeInterval = 15 * 60

    /// 报告时区固定 UTC+8(与引擎的 TZ 一致),否则"今天"会在两边错开。
    static let reportTimeZone = TimeZone(identifier: "Asia/Shanghai") ?? TimeZone(secondsFromGMT: 8 * 3600)!
    static func calendar() -> Calendar {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = reportTimeZone; return cal
    }
    static func dayKey(_ date: Date) -> String {
        let c = calendar().dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// 纯函数:这一分钟到底该不该调用引擎。抽出来是为了能在 --self-test 里断言,
    /// 因为它决定了"自动出报/自动提交"是否还会发生。
    static func tickDue(now: Date, lastTickAt: Date?, submittedDay: String?) -> Bool {
        let cal = calendar()
        let minute = cal.component(.hour, from: now) * 60 + cal.component(.minute, from: now)
        guard minute >= tickWindowStartMinute else { return false }
        if submittedDay == dayKey(now) { return false }
        if let last = lastTickAt, now.timeIntervalSince(last) < tickRetryInterval { return false }
        return true
    }

    /// 到点就记账并返回 true(真正的引擎调用由调用方发起)。
    func tickIfDue(now: Date = Date()) -> Bool {
        guard AppDelegate.tickDue(now: now, lastTickAt: lastTickAt, submittedDay: submittedTickDay) else { return false }
        lastTickAt = now
        return true
    }

    /// 报告内容变了(排除/恢复/重新生成)就重新放开自动 tick:
    /// 引擎会把状态置回 ready/stale,18:00 之后应当自动重新提交,否则"当天改完不算数"。
    func rearmAutoTick() {
        submittedTickDay = nil
        lastTickAt = nil
        DebugLog.write("auto tick re-armed")
    }
    func applicationDidFinishLaunching(_ n: Notification) { DebugLog.write("app launch pid=\(ProcessInfo.processInfo.processIdentifier) bundle=\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") ?? "unknown") ui=\(Bundle.main.object(forInfoDictionaryKey: "DigestUIBuildID") ?? "unknown")"); installMainMenu(); statusItem=NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength); statusItem.button?.image = {
            // 菜单栏用从 App 图标派生的单色 Template 图标;取不到再回退系统符号
            if let url = Bundle.main.url(forResource: "MenuBarIconTemplate", withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                image.isTemplate = true
                return image
            }
            return NSImage(systemSymbolName: "checklist", accessibilityDescription: "Daily Agent Digest")
        }(); let m=makeMenu(); statusItem.menu=m; report=ReportController(backend:backend); ensureLoginItem(); refreshLoginItemState(); NotificationCenter.default.addObserver(forName: .digestReportChanged, object: nil, queue: .main) { [weak self] _ in self?.rearmAutoTick() }; let tickTimer=Timer(timeInterval:60,repeats:true){ [weak self] _ in
              // 每分钟都起一个引擎进程是纯粹的浪费(实测每次启动秒级):只有进入当天
              // 自动窗口后才调用,且提交成功后当天不再调用。是否该调用由纯函数决定,
              // 便于 --self-test 断言。
              guard let self = self, self.tickIfDue() else { return }
              // tick 可能触发完整的 LLM 生成(实测 40s+,超时更久):默认 60s 会被 watchdog
              // 杀掉,state 不落盘、下一分钟重试再被杀,自动出报可能永远失败。
              self.backend.call("tick", [:], timeout: Backend.generateTimeout) { [weak self] obj in
                  if let error = obj["error"] as? String { DebugLog.write("tick failed: \(error)") }
                  else if obj["submit_status"] as? String == "submitted" {
                      self?.submittedTickDay = AppDelegate.dayKey(Date())
                      DebugLog.write("tick submitted, no further tick today")
                  }
              }
          }; RunLoop.main.add(tickTimer,forMode:.common); timer=tickTimer; if ProcessInfo.processInfo.environment["DIGEST_DEBUG_AUTOGENERATE"] == "1" { DebugLog.write("auto generate requested by DIGEST_DEBUG_AUTOGENERATE"); self.perform(#selector(self.generate), with: nil, afterDelay: 1.0) }; if ProcessInfo.processInfo.environment["DIGEST_DEBUG_SHOWREPORT"] == "1" { DebugLog.write("report window requested by DIGEST_DEBUG_SHOWREPORT"); self.perform(#selector(self.show), with: nil, afterDelay: 1.0) }; if ProcessInfo.processInfo.environment["DIGEST_DEBUG_SHOWABOUT"] == "1" { DebugLog.write("about requested by DIGEST_DEBUG_SHOWABOUT"); self.perform(#selector(self.about), with: nil, afterDelay: 1.0) } }
    @objc func show(){
        report.refresh()
        report.showWindow(nil)
        // A menu-bar (accessory) app is not raised above the frontmost regular
        // app by activation alone, which left the report hidden behind whatever
        // the user had in front.
        report.window?.makeKeyAndOrderFront(nil)
        report.window?.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps:true)
        if let frame = report.window?.frame { DebugLog.write("report window shown at \(Int(frame.minX)),\(Int(frame.minY)) size \(Int(frame.width))x\(Int(frame.height))") }
    }
    @objc func generate(){
        // Generation progress is shown in a NON-modal panel on purpose.
        // A modal NSAlert cannot be re-laid out once running (which left a stale
        // progress bar and no visible buttons), and runModal() blocks the serial
        // main dispatch queue, so work enqueued with DispatchQueue.main.async was
        // never executed while the dialog was up.
        generationBackgrounded = false
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 132),
                            styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "正在生成今日总结"
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 132))
        let label = NSTextField(labelWithString: "正在汇总当天所有 agent 工作记录，请稍候。")
        label.frame = NSRect(x: 24, y: 84, width: 392, height: 20)
        label.textColor = .secondaryLabelColor
        content.addSubview(label)
        let indicator = NSProgressIndicator(frame: NSRect(x: 24, y: 54, width: 392, height: 20))
        indicator.style = .bar
        indicator.isIndeterminate = true
        indicator.startAnimation(nil)
        content.addSubview(indicator)
        let background = NSButton(title: "后台运行", target: self, action: #selector(sendGenerationToBackground(_:)))
        background.frame = NSRect(x: 330, y: 14, width: 86, height: 28)
        background.bezelStyle = .rounded
        content.addSubview(background)
        panel.contentView = content
        progressPanel = panel
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DebugLog.write("generation progress panel shown")

        backend.call("clear") { _ in
            self.backend.call("generate", timeout: Backend.generateTimeout) { state in
                self.closeProgressPanel()
                if self.generationBackgrounded {
                    DebugLog.write("generation finished in background status=\(state["report_status"] ?? "?")")
                    self.report.refresh()
                } else {
                    self.report.refresh()
                    // 新生成的报告应当能自动提交,所以重新放开 tick 门控。
                    self.rearmAutoTick()
                    // Hop so the finishing block returns before the alert takes
                    // over the main queue.
                    DispatchQueue.main.async { self.presentGenerationResult(state) }
                }
            }
        }
    }

    @objc func sendGenerationToBackground(_ sender: Any?) {
        generationBackgrounded = true
        closeProgressPanel()
        DebugLog.write("generation sent to background by user")
    }

    func closeProgressPanel() {
        progressPanel?.orderOut(nil)
        progressPanel = nil
    }

    func presentGenerationResult(_ state: [String: Any]) {
        let alert = NSAlert()
        if let reason = Backend.failureReason(state) {
            alert.alertStyle = .warning
            alert.messageText = "生成失败"
            alert.informativeText = reason
            alert.addButton(withTitle: "确定")
            presentAlert(alert)
            DebugLog.write("generation reported failure: \(reason)")
            report.refresh()
        } else {
            let count = (state["work_items"] as? [[String: Any]])?.count ?? 0
            alert.messageText = "今日总结生成成功"
            alert.informativeText = "已生成 \(count) 个工作主题，可以查看最新内容。"
            alert.addButton(withTitle: "查看今日总结")
            alert.addButton(withTitle: "关闭")
            DebugLog.write("generation result alert shown items=\(count)")
            if presentAlert(alert) == .alertFirstButtonReturn { show() }
        }
    }
    /// 菜单栏(accessory)应用的弹窗不会自动浮到前台,必须显式激活并置顶,
    /// 否则 alert 可能整体藏在浏览器/聊天窗口之后(D-23 的同一类问题)。
    @discardableResult
    func presentAlert(_ alert: NSAlert) -> NSApplication.ModalResponse {
        NSApp.activate(ignoringOtherApps: true)
        alert.window.level = .floating
        return alert.runModal()
    }

    // MARK: - 版本信息与更新检查

    /// 从 "v0.5.0" / "dev-a3f9c1b" 取数字段;非数字版本(开发构建)返回 nil。
    static func versionNumbers(_ tag: String) -> [Int]? {
        let cleaned = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        let parts = cleaned.split(separator: ".").map { Int($0.prefix(while: { $0.isNumber })) }
        guard !parts.isEmpty, parts.allSatisfy({ $0 != nil }) else { return nil }
        return parts.map { $0! }
    }

    /// candidate 是否比 current 新;任一版本不是数字版本时返回 nil(无法比较)。
    static func isNewer(_ candidate: String, than current: String) -> Bool? {
        guard let a = versionNumbers(candidate), let b = versionNumbers(current) else { return nil }
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    /// 运行中的版本信息:应用包、UI 构建、引擎自报版本与路径。
    func releaseInfo() -> [(String, String)] {
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let uiBuild = Bundle.main.object(forInfoDictionaryKey: "DigestUIBuildID") as? String ?? "unknown"
        let home = DigestPaths.dataDirectory
        return [
            ("应用版本", appVersion),
            ("UI 构建", uiBuild),
            ("引擎版本", report.stateRelease),
            ("引擎路径", backend.executable),
            ("应用路径", Bundle.main.bundlePath),
            ("数据目录", home),
        ]
    }

    /// 查询发布仓库的最新 release tag。只有用户显式触发(点击按钮或
    /// --check-version)时才会联网。
    static func fetchLatestVersion(completion: @escaping (Result<String, Error>) -> Void) {
        let urlString = ProcessInfo.processInfo.environment["DIGEST_RELEASES_API"]
            ?? "https://api.github.com/repos/mzlc-linmo/daily-agent-digest/releases/latest"
        guard let url = URL(string: urlString) else {
            completion(.failure(NSError(domain: "digest", code: 1,
                                        userInfo: [NSLocalizedDescriptionKey: "无法解析发布仓库地址"])))
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        // ephemeral:版本检查不该在磁盘上留下缓存数据库
        URLSession(configuration: .ephemeral).dataTask(with: request) { data, _, error in
            if let error = error { completion(.failure(error)); return }
            guard let data = data,
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let tag = obj["tag_name"] as? String else {
                completion(.failure(NSError(domain: "digest", code: 2,
                                            userInfo: [NSLocalizedDescriptionKey: "发布仓库没有返回可识别的版本号"])))
                return
            }
            completion(.success(tag))
        }.resume()
    }

    /// 把"当前版本 vs 最新版本"翻译成一句人话。
    static func versionVerdict(current: String, latest: String) -> String {
        guard let newer = isNewer(latest, than: current) else {
            return "当前是开发构建(\(current)),无法与发布版本 \(latest) 比较。"
        }
        return newer
            ? "有新版本可用:最新 \(latest),当前 \(current)。"
            : "当前已是最新版本(\(current))。"
    }

    @objc func about(){
        // 只弹一个版本号。此前这里还起了一个引擎进程,只为往调试日志里写一行引擎版本 ——
        // 引擎启动是秒级开销,而版本号在 state 里已经有缓存。
        let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        DebugLog.write("about shown app=\(appVersion) report=\(report.stateRelease) enginePath=\(backend.executable)")
        let alert = NSAlert()
        alert.messageText = "当前版本:\(appVersion)"
        alert.addButton(withTitle: "检查最新版本")
        alert.addButton(withTitle: "关闭")
        if self.presentAlert(alert) == .alertFirstButtonReturn {
            self.checkLatestVersion(current: appVersion)
        }
    }

    /// 用户显式点击时才联网:请求公共发布仓库的最新 release tag。
    func checkLatestVersion(current: String){
        DebugLog.write("version check start current=\(current)")
        AppDelegate.fetchLatestVersion { [weak self] result in
            let message: String
            switch result {
            case .success(let latest): message = AppDelegate.versionVerdict(current: current, latest: latest)
            case .failure(let error): message = "检查失败:\(error.localizedDescription)"
            }
            DebugLog.write("version check done: \(message)")
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "版本检查"
                alert.informativeText = message
                alert.addButton(withTitle: "好")
                self?.presentAlert(alert)
            }
        }
    }

    // 设置窗口做成**非模态面板**:测试连接在窗口内显示结果、窗口不关闭,
    // 密钥字段明文可见(掩码让用户无法确认粘贴是否成功)。
    private var settingsPanel: NSPanel?
    private var settingsFields: [String: NSTextField] = [:]
    private var settingsStatus: NSTextField?
    /// 上一次从引擎读到的配置。设置窗口用它**立即**出现:以前窗口是在引擎返回之后
    /// 才创建的,引擎启动要几秒,用户点完「设置」会先看到几秒毫无反应。
    private var settingsCache: [String: Any]?
    /// 建框时各输入框的初值:读取结果回来时只覆盖"用户没动过"的字段。
    private var settingsBaseline: [String: String] = [:]
    private var settingsLoading = false

    @objc func settings(){
        if let existing = settingsPanel { existing.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        presentSettingsPanel(settingsCache)
        refreshSettingsFromEngine()
    }

    /// 立刻把窗口画出来:有缓存就用缓存值,没有就先留空并提示正在读取。
    private func presentSettingsPanel(_ values: [String: Any]?) {
        let width: CGFloat = 560, height: CGFloat = 320
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "日报设置"
        panel.isReleasedWhenClosed = false
        // 红叉关闭也要走同一套清理:此前只有「关闭」按钮会清空引用,
        // 红叉关掉后引用还在,下次点「设置」走的是另一条分支,快慢不一致。
        panel.delegate = self
        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))

        var fields: [String: NSTextField] = [:]
        var baseline: [String: String] = [:]
        func addField(_ label: String, _ key: String, _ y: CGFloat) {
            let caption = NSTextField(labelWithString: label)
            caption.frame = NSRect(x: 20, y: y + 4, width: 110, height: 22)
            caption.alignment = .right
            content.addSubview(caption)
            let value = values?[key] as? String ?? ""
            let input = NSTextField(string: value)   // 明文:便于核对是否粘贴成功
            input.frame = NSRect(x: 140, y: y, width: width - 170, height: 26)
            content.addSubview(input)
            fields[key] = input
            baseline[key] = value
        }
        addField("LLM Base URL", "base_url", 274)
        addField("Model", "model", 238)
        addField("LLM API Key", "api_key", 202)
        addField("提交地址", "submit_url", 166)
        addField("提交 API Key", "submit_api_key", 130)

        let status = NSTextField(labelWithString: "")
        status.frame = NSRect(x: 20, y: 88, width: width - 40, height: 36)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 2
        content.addSubview(status)

        func addButton(_ title: String, _ action: Selector, _ x: CGFloat, _ w: CGFloat) {
            let b = NSButton(title: title, target: self, action: action)
            b.frame = NSRect(x: x, y: 22, width: w, height: 32)
            b.bezelStyle = .rounded
            content.addSubview(b)
        }
        addButton("保存", #selector(saveSettingsFromPanel), 20, 100)
        addButton("测试连接", #selector(testConnectionFromPanel), 130, 110)
        addButton("关闭", #selector(closeSettingsPanel), width - 120, 100)

        panel.contentView = content
        settingsPanel = panel
        settingsFields = fields
        settingsBaseline = baseline
        settingsStatus = status
        if settingsCache == nil {
            status.stringValue = "正在读取当前配置…"
        } else {
            setSettingsStatus("改完点「保存」；「测试连接」只测试当前输入,不会自动保存。", .secondaryLabelColor)
        }
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DebugLog.write("settings panel shown cached=\(settingsCache != nil)")
    }

    private func setSettingsStatus(_ text: String, _ color: NSColor) {
        settingsStatus?.stringValue = text
        settingsStatus?.textColor = color
    }

    /// 后台读一次真实配置。在途保护:面板未出现时连点「设置」不再并发拉起多个引擎进程。
    private func refreshSettingsFromEngine() {
        guard !settingsLoading else {
            setSettingsStatus("正在读取当前配置…", .secondaryLabelColor)
            return
        }
        settingsLoading = true
        backend.call("settings") { [weak self] current in
            guard let self = self else { return }
            self.settingsLoading = false
            if let error = current["error"] as? String {
                self.setSettingsStatus("读取配置失败：\(error)", .systemRed)
                return
            }
            self.settingsCache = current
            self.applySettingsToFields(current)
            self.setSettingsStatus("改完点「保存」；「测试连接」只测试当前输入,不会自动保存。", .secondaryLabelColor)
        }
    }

    /// 只覆盖用户没改过的字段:读取期间敲进去的内容不能被回来结果冲掉。
    private func applySettingsToFields(_ current: [String: Any]) {
        for (key, field) in settingsFields {
            guard field.stringValue == (settingsBaseline[key] ?? "") else { continue }
            guard let value = current[key] as? String else { continue }
            field.stringValue = value
            settingsBaseline[key] = value
        }
    }

    private func settingsPayload() -> [String: Any] {
        var payload: [String: Any] = [:]
        for (key, field) in settingsFields { payload[key] = field.stringValue }
        return payload
    }

    @objc func saveSettingsFromPanel() {
        backend.call("save-settings", settingsPayload()) { [weak self] result in
            guard let self = self else { return }
            if let error = result["error"] as? String {
                self.setSettingsStatus("保存失败：\(error)", .systemRed)
            } else {
                // save-settings 返回落盘后的完整配置,顺手刷新缓存与基线。
                self.settingsCache = result
                self.settingsBaseline = self.settingsFields.mapValues { $0.stringValue }
                self.setSettingsStatus("已保存。之后提交会自动复用这份配置。", .systemGreen)
            }
        }
    }

    @objc func testConnectionFromPanel() {
        setSettingsStatus("正在测试…", .secondaryLabelColor)
        // 只测当前输入(不落盘):测试失败也不会污染已保存的配置
        backend.call("check-submit", settingsPayload()) { [weak self] result in
            guard let self = self else { return }
            if let error = result["error"] as? String {
                self.setSettingsStatus("连接失败：\(error)", .systemRed)
            } else {
                let member = result["member"] as? String ?? "未知"
                self.setSettingsStatus("连接成功：服务端识别为「\(member)」。确认无误后点「保存」。", .systemGreen)
            }
        }
    }

    @objc func closeSettingsPanel() {
        settingsPanel?.close()   // 清理统一交给 windowWillClose
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === settingsPanel else { return }
        settingsPanel = nil
        settingsFields = [:]
        settingsBaseline = [:]
        settingsStatus = nil
    }

    /// 统一的小提示弹窗(始终置顶)
    func showInfo(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        presentAlert(alert)
    }

    /// 开机自启:用 SMAppService 注册为登录项,不再依赖 launchd plist。
    func loginItemEnabled() -> Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }

    /// 菜单对勾跟随**真实**状态:读的是 SMAppService,而不是"我们以为设置成了什么"。
    /// 注册可能被系统拒绝或被用户在系统设置里改掉,那时对勾必须如实显示。
    func applyLoginItemState(enabled: Bool) {
        loginItemMenuItem?.state = enabled ? .on : .off
    }

    func refreshLoginItemState() {
        applyLoginItemState(enabled: loginItemEnabled())
    }

    /// 每次打开菜单都重读一次:用户可能在「系统设置 → 通用 → 登录项」里改过。
    func menuWillOpen(_ menu: NSMenu) {
        refreshLoginItemState()
    }

    /// 托盘 App 默认**没有主菜单**,而 ⌘V / ⌘C / ⌘X / ⌘A / ⌘Z 并不是输入框自己处理的:
    /// 它们是主菜单里「编辑」菜单项的快捷键(key equivalent),由菜单项去分发
    /// paste: / copy: / cut: / selectAll: / undo:。没有主菜单,这些组合键就没有人响应,
    /// 只有右键菜单里的「粘贴」还能用 —— 这正是设置窗口里 ⌘V 失效的原因。
    /// 这个菜单栏在 .accessory 应用里不会显示出来,只为提供快捷键。
    func installMainMenu() {
        let main = NSMenu()

        // 第一个菜单必须是"应用菜单",AppKit 依赖这个位置;顺便让 ⌘Q 可用。
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "退出 Daily Agent Digest", action: #selector(quit), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        edit.addItem(NSMenuItem(title: "撤销", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(NSMenuItem.separator())
        edit.addItem(NSMenuItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = edit

        NSApp.mainMenu = main
        DebugLog.write("main menu installed edit_items=\(edit.items.count)")
    }

    /// 菜单单独成方法,好让 --dump-menu 在无头环境下检查结构(含「开机自启」的对勾)。
    func makeMenu() -> NSMenu {
        let m=NSMenu()
        m.addItem(NSMenuItem(title:"查看今日总结", action:#selector(show), keyEquivalent:""))
        m.addItem(NSMenuItem(title:"生成今日总结", action:#selector(generate), keyEquivalent:""))
        m.addItem(NSMenuItem.separator())
        m.addItem(NSMenuItem(title:"设置", action:#selector(settings), keyEquivalent:","))
        let loginItem=NSMenuItem(title:"开机自启", action:#selector(toggleLoginItem), keyEquivalent:"")
        m.addItem(loginItem)
        loginItemMenuItem=loginItem
        m.addItem(NSMenuItem.separator())
        m.addItem(NSMenuItem(title:"关于", action:#selector(about), keyEquivalent:""))
        m.addItem(NSMenuItem(title:"退出", action:#selector(quit), keyEquivalent:"q"))
        m.delegate=self
        return m
    }

    private func ensureLoginItem() {
        guard #available(macOS 13.0, *) else { return }
        if SMAppService.mainApp.status != .enabled {
            do { try SMAppService.mainApp.register(); DebugLog.write("login item registered") }
            catch { DebugLog.write("login item register failed: \(error.localizedDescription)") }
        }
    }

    @objc func toggleLoginItem() {
        guard #available(macOS 13.0, *) else { showInfo("不支持", "开机自启需要 macOS 13 或更新版本。"); return }
        var notice: (String, String)?
        do {
            if loginItemEnabled() { try SMAppService.mainApp.unregister(); notice = ("已关闭", "已取消开机自启。") }
            else { try SMAppService.mainApp.register(); notice = ("已开启", "开机后会随登录自动启动。") }
        } catch { notice = ("设置失败", error.localizedDescription) }
        // 先按系统真实状态刷新对勾,再弹提示:showInfo 是模态的,放在后面会让对勾晚一步更新。
        refreshLoginItemState()
        DebugLog.write("login item toggled enabled=\(loginItemEnabled())")
        if let notice = notice { showInfo(notice.0, notice.1) }
    }

    @objc func quit(){ timer.invalidate(); NSApp.terminate(nil) }
}

/// Headless regression checks for the state -> outcome mapping. The GUI itself
/// cannot be driven from CI, but the bug that made a failed generation look like
/// a success lived exactly here, so it is asserted directly.
enum SelfTest {
    static func run() -> Bool {
        var passed = true
        func expect(_ name: String, _ state: [String: Any], _ wantFailure: Bool) {
            let reason = Backend.failureReason(state)
            let ok = (reason != nil) == wantFailure
            if !ok { passed = false }
            print("\(ok ? "PASS" : "FAIL") \(name) -> reason=\(reason ?? "nil")")
        }
        expect("ready state counts as success", ["report_status": "ready", "last_error": NSNull()], false)
        expect("submitted state counts as success", ["report_status": "submitted"], false)
        expect("llm fallback (report_status=error) counts as failure",
               ["report_status": "error", "last_error": "JSONDecodeError: Expecting value"], true)
        expect("missing last_error is not success",
               ["report_status": "error"], true)
        expect("engine error key counts as failure", ["error": "unknown work item id"], true)
        expect("in-flight state is not success", ["report_status": "generating"], true)
        expect("empty state is not success", [:], true)
        expect("stale last_error blocks success",
               ["report_status": "ready", "last_error": "previously failed"], true)

        // Row height must fit the whole work-item body: the body is 100-300
        // characters of mostly CJK text, which must wrap over several lines.
        let sample = String(repeating: "梳理 Codex 会话表结构，确认按日窗口过滤；", count: 7)
        let width: CGFloat = 712
        let font = NSFont.systemFont(ofSize: 11)
        let layoutHeight = ReportController.textHeight(sample, font: font, width: width)
        let boundingHeight = ReportController.boundingRectHeight(sample, font: font, width: width)
        print("     body chars=\(sample.count) width=\(Int(width)) layoutHeight=\(layoutHeight) boundingRectHeight=\(boundingHeight)")
        if layoutHeight < 30 {
            passed = false
            print("FAIL long body must measure more than one line -> \(layoutHeight)")
        } else {
            print("PASS long body wraps over multiple lines -> \(layoutHeight)pt")
        }
        // The report body is the item array: excluding one removes exactly one
        // heading+body block and leaves the rest untouched.
        let full = ReportController.composeDocument(items: [
            ["title": "采集器重构", "desc": "把三个数据源的窗口过滤统一。", "excluded": false],
            ["title": "CI 签名修复", "desc": "先签内层再签外层。", "excluded": false],
        ]).string
        if full.contains("采集器重构") && full.contains("把三个数据源的窗口过滤统一。")
            && full.contains("CI 签名修复") && full.contains("先签内层再签外层。") {
            print("PASS every included item contributes a heading and its body")
        } else {
            passed = false
            print("FAIL included items missing from the document -> \(full)")
        }
        let one = ReportController.composeDocument(items: [
            ["title": "采集器重构", "desc": "把三个数据源的窗口过滤统一。", "excluded": false],
            ["title": "CI 签名修复", "desc": "先签内层再签外层。", "excluded": true],
        ]).string
        if !one.contains("CI 签名修复") && !one.contains("先签内层再签外层。") && one.contains("采集器重构") {
            print("PASS excluding an item removes its heading and body, leaving the rest untouched")
        } else {
            passed = false
            print("FAIL excluded item still present or kept item lost -> \(one)")
        }
        let none = ReportController.composeDocument(items: [
            ["title": "甲", "desc": "内容甲", "excluded": true],
        ]).string
        if none.contains("没有可上报的内容") {
            print("PASS excluding everything reports an empty report")
        } else {
            passed = false
            print("FAIL empty report message missing -> \(none)")
        }
        let chars = ReportController.includedChars(items: [
            ["title": "甲", "desc": "一二三", "excluded": false],
            ["title": "乙", "desc": "四五六", "excluded": true],
        ])
        if chars == 4 {
            print("PASS report size counts only included items")
        } else {
            passed = false
            print("FAIL included char count wrong -> \(chars)")
        }

        // 版本比较:用于判断当前运行的版本是否最新。
        let cases: [(String, String, Bool?)] = [
            ("v0.5.1", "v0.5.0", true),
            ("v0.5.0", "v0.5.0", false),
            ("v0.5.0", "v0.5.1", false),
            ("v0.6.0", "v0.5.9", true),
            ("v0.5.10", "v0.5.9", true),
            ("dev-a3f9c1b", "v0.5.0", nil),
            ("v0.5.0", "dev-a3f9c1b", nil),
        ]
        let wrong = cases.filter { AppDelegate.isNewer($0.0, than: $0.1) != $0.2 }
        if wrong.isEmpty {
            print("PASS version comparison identifies newer, equal, older and dev builds")
        } else {
            passed = false
            print("FAIL version comparison wrong for \(wrong.map { "\($0.0) vs \($0.1)" })")
        }

        let shortHeight = ReportController.textHeight("短标题", font: font, width: width)
        if shortHeight <= 0 || shortHeight > 26 {
            passed = false
            print("FAIL short text should measure about one line -> \(shortHeight)")
        } else {
            print("PASS short text measures one line -> \(shortHeight)pt")
        }

        // Markdown 导出:只含计入的条目、编号连续、页脚统计与条目一致。
        let mdItems: [[String: Any]] = [
            ["title": "修复重复写入", "desc": "把提交改为按天覆盖。", "chars": 12, "excluded": false],
            ["title": "被排除的主题", "desc": "不该出现在文档里。", "chars": 99, "excluded": true],
            ["title": "梳理托盘菜单", "desc": "菜单项与快捷键。", "chars": 9, "excluded": false],
        ]
        let doc = ReportController.markdownDocument(items: mdItems, day: "2026-09-14")
        let mdChecks: [(String, Bool)] = [
            ("标题含日期", doc.contains("# 今日工作日报 · 2026-09-14")),
            ("第一条编号为 1", doc.contains("## 1. 修复重复写入")),
            ("排除中间项后编号仍连续", doc.contains("## 2. 梳理托盘菜单")),
            ("正文跟在标题下", doc.contains("把提交改为按天覆盖。")),
            ("排除项不出现", !doc.contains("被排除的主题")),
            ("工作项计数正确", doc.contains("- 工作项:2 项")),
            ("字数合计正确", doc.contains("- 正文合计:21 字")),
        ]
        let mdWrong = mdChecks.filter { !$0.1 }.map { $0.0 }
        if mdWrong.isEmpty {
            print("PASS markdown export contains only included items, numbered and counted")
        } else {
            passed = false
            print("FAIL markdown export wrong: \(mdWrong)")
        }
        let warnedDoc = ReportController.markdownDocument(
            items: mdItems, day: "2026-09-14", warnings: ["未做主题归并:未配置 LLM(LLM_BASE_URL / LLM_API_KEY / LLM_MODEL);以下为按来源分组的原始记录"])
        if warnedDoc.contains("> ⚠️ 未做主题归并"), warnedDoc.contains("未配置 LLM") {
            print("PASS markdown export carries the engine warnings")
        } else {
            passed = false
            print("FAIL markdown export dropped the warnings")
        }
        let emptyDoc = ReportController.markdownDocument(items: [], day: "")
        if emptyDoc.contains("没有计入的条目"), emptyDoc.contains("- 工作项:0 项"), emptyDoc.contains("未知日期") {
            print("PASS markdown export handles an empty report")
        } else {
            passed = false
            print("FAIL markdown export empty case wrong")
        }

        // 自动 tick 门控:改坏了就等于"自动出报/自动提交"静默失效,或者又变回每分钟空转。
        let cal = AppDelegate.calendar()
        func at(_ day: String, _ hour: Int, _ minute: Int) -> Date {
            let parts = day.split(separator: "-").compactMap { Int($0) }
            var c = DateComponents()
            c.year = parts[0]; c.month = parts[1]; c.day = parts[2]; c.hour = hour; c.minute = minute
            return cal.date(from: c) ?? Date()
        }
        let today = "2026-09-14"
        let tickCases: [(String, Date, Date?, String?, Bool)] = [
            ("before the window nothing happens", at(today, 9, 0), nil, nil, false),
            ("17:29 still nothing", at(today, 17, 29), nil, nil, false),
            ("17:30 opens the window", at(today, 17, 30), nil, nil, true),
            ("a second call one minute later is throttled", at(today, 17, 31), at(today, 17, 30), nil, false),
            ("retry allowed after the interval", at(today, 17, 46), at(today, 17, 30), nil, true),
            ("already submitted today stops ticking", at(today, 19, 0), nil, today, false),
            ("a new day ticks again", at("2026-09-15", 17, 30), at(today, 17, 30), today, true),
        ]
        let wrongTicks = tickCases.filter { AppDelegate.tickDue(now: $0.1, lastTickAt: $0.2, submittedDay: $0.3) != $0.4 }
        if wrongTicks.isEmpty {
            print("PASS auto tick gate opens only in the daily window and throttles retries")
        } else {
            passed = false
            print("FAIL auto tick gate wrong for \(wrongTicks.map { $0.0 })")
        }
        return passed
    }
}

if CommandLine.arguments.contains("--check-version") {
    // 无头版本检查:便于脚本与 CI 验证"当前版本是否最新"这条链路。
    let current = CommandLine.arguments.first(where: { $0.hasPrefix("--current=") })
        .map { String($0.dropFirst("--current=".count)) }
        ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown")
    let semaphore = DispatchSemaphore(value: 0)
    var output = "检查失败:没有返回结果"
    AppDelegate.fetchLatestVersion { result in
        switch result {
        case .success(let latest): output = AppDelegate.versionVerdict(current: current, latest: latest)
        case .failure(let error): output = "检查失败:\(error.localizedDescription)"
        }
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 20)
    print(output)
    exit(output.hasPrefix("检查失败") ? 1 : 0)
}

if CommandLine.arguments.contains("--paste-check") {
    // 「⌘V 到底能不能用」这件事值得真的试一次:合成一个 ⌘V 交给主菜单,
    // 看剪贴板内容有没有落进输入框。没有主菜单时这一步根本不会发生。
    _ = NSApplication.shared
    let delegate = AppDelegate()
    delegate.installMainMenu()

    guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command],
                                       timestamp: 0, windowNumber: 0, context: nil,
                                       characters: "v", charactersIgnoringModifiers: "v",
                                       isARepeat: false, keyCode: 9) else {
        print("FAIL 无法合成 ⌘V 事件"); exit(1)
    }
    // 1) 主菜单必须认领这个组合键(这是设置窗口里 ⌘V 失效的直接原因)
    let claimed = NSApp.mainMenu?.performKeyEquivalent(with: event) ?? false
    print(claimed ? "PASS 主菜单认领了 ⌘V" : "FAIL 主菜单没有认领 ⌘V(paste: 项缺失或键位不对)")
    guard claimed else { exit(1) }

    // 2) 真把内容粘进输入框。这需要窗口成为 key window;做不到就如实说跳过,
    //    不把环境限制伪装成通过。
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 64),
                          styleMask: [.titled], backing: .buffered, defer: false)
    let field = NSTextField(frame: NSRect(x: 10, y: 12, width: 300, height: 24))
    window.contentView?.addSubview(field)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    _ = window.makeFirstResponder(field)
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString("PASTED-BY-CMD-V", forType: .string)
    field.stringValue = ""
    _ = NSApp.mainMenu?.performKeyEquivalent(with: event)
    if field.stringValue == "PASTED-BY-CMD-V" {
        print("PASS ⌘V 把剪贴板内容粘进了输入框")
        exit(0)
    }
    // 窗口拿不到 key 状态时,⌘V 不会被派发到字段;那就单独验证 paste: 动作本身。
    // 加上上面"主菜单认领 ⌘V"一条,整条链路就是完整的(菜单接线 + 动作可用)。
    if let editor = window.fieldEditor(true, for: field) as? NSTextView {
        editor.paste(nil)
        if field.stringValue == "PASTED-BY-CMD-V" {
            print("PASS paste: 动作把剪贴板内容写进了输入框")
            exit(0)
        }
        print("FAIL paste: 动作没有写入内容 -> \"\(field.stringValue)\"")
        exit(1)
    }
    print("SKIP 当前环境无法构造 field editor,只验证了菜单接线")
    exit(0)
}

if CommandLine.arguments.contains("--markdown-demo") {
    // 无头打印一份样例文档:Markdown 导出的格式不需要开 GUI 就能核对。
    let sample: [[String: Any]] = [
        ["title": "修复日报提交的重复写入", "desc": "把提交改为按天覆盖,重新生成不再产生重复行,并在状态里记录 submit_mode 便于排查。", "chars": 82, "excluded": false],
        ["title": "排查设置窗口卡顿", "desc": "定位到每次调用都要重新解包引擎,改为 onedir 后单次启动从 5 秒降到 0.07 秒。", "chars": 74, "excluded": false],
        ["title": "内部调试记录(已排除)", "desc": "这一项被排除了,不该出现在文档里。", "chars": 40, "excluded": true],
    ]
    print(ReportController.markdownDocument(
        items: sample, day: "2026-09-14",
        warnings: ["未做主题归并:未配置 LLM(LLM_BASE_URL / LLM_API_KEY / LLM_MODEL);以下为按来源分组的原始记录",
                   "zstd 未安装,无法解压 .dsh 会话(brew install zstd)"]), terminator: "")
    exit(0)
}

if CommandLine.arguments.contains("--dump-menu") {
    // 无头检查菜单结构:菜单是纯 GUI 的,不然「开机自启」的对勾只能靠肉眼确认。
    // 输出 `标题|动作|状态`,并额外给出系统里登录项的真实状态供断言比对。
    _ = NSApplication.shared
    let delegate = AppDelegate()
    let menu = delegate.makeMenu()
    delegate.refreshLoginItemState()
    print("login-item-enabled|\(delegate.loginItemEnabled() ? "on" : "off")")
    // 两种取值都驱动一遍,证明对勾确实跟着状态变(不触碰真实的登录项注册)。
    delegate.applyLoginItemState(enabled: true)
    print("checkmark-when-enabled|\(delegate.loginItemMenuItem.state == .on ? "on" : "off")")
    delegate.applyLoginItemState(enabled: false)
    print("checkmark-when-disabled|\(delegate.loginItemMenuItem.state == .on ? "on" : "off")")
    delegate.refreshLoginItemState()
    for item in menu.items {
        let action = item.action.map { NSStringFromSelector($0) } ?? "-"
        let state = item.isSeparatorItem ? "separator" : (item.state == .on ? "on" : "off")
        print("\(item.title)|\(action)|\(state)")
    }
    // 主菜单里的「编辑」项提供 ⌘V/⌘C/⌘X/⌘A,没有它输入框就粘贴不了。
    delegate.installMainMenu()
    for top in NSApp.mainMenu?.items ?? [] {
        for item in top.submenu?.items ?? [] {
            let action = item.action.map { NSStringFromSelector($0) } ?? "-"
            let mods = item.keyEquivalentModifierMask.contains(.command) ? "cmd" : "-"
            print("mainmenu|\(item.title)|\(action)|\(item.keyEquivalent)|\(mods)")
        }
    }
    exit(0)
}

if CommandLine.arguments.contains("--engine-path") {
    // 无头输出实际会使用的引擎路径:打包方式换过几次(onedir / onefile / 数据目录),
    // 这条命令让 CI 与冒烟测试能直接断言 App 选中的到底是哪一个。
    print(Backend().executable)
    exit(FileManager.default.isExecutableFile(atPath: Backend().executable) ? 0 : 1)
}

if CommandLine.arguments.contains("--self-test") {
    DebugLog.write("self test start")
    let ok = SelfTest.run()
    DebugLog.write("self test done pass=\(ok)")
    exit(ok ? 0 : 1)
}

let app=NSApplication.shared; let delegate=AppDelegate(); app.delegate=delegate; app.setActivationPolicy(.accessory); app.run()
