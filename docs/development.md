# 本地开发指南

开发版从源码运行(不打包、不安装),使用仓库内 `.dev/` 作为隔离的应用数据目录,因此**不会读写 `~/.local/share/daily-agent-digest`**,也不会注册任何 launchd 服务。

## 快速开始

```bash
./scripts/dev.sh setup      # 准备 .dev/(隔离 home、.env、fixture 数据源、引擎 wrapper)
./scripts/dev.sh test       # 跑单元测试
./scripts/dev.sh generate   # 离线跑一次完整生成(内置 mock LLM,不消耗额度)
./scripts/dev.sh app        # 编译并启动开发版菜单栏应用
```

`dev.sh setup` 会把已安装版本的 `.env` **复制一份**到 `.dev/home/.env`(权限 600)。这样 live 模式可以直接用现有 key,同时 `.dev/` 已在 `.gitignore` 中,不会进仓库。

## 隔离边界

| 项目 | 开发版 | 正式版(已停用,保留可回滚) |
| --- | --- | --- |
| 应用数据目录 | `<repo>/.dev/home` | `~/.local/share/daily-agent-digest` |
| 引擎 | `.dev/bin/dev-engine` → 直接执行 `daily_agent_digest.py` | 打包二进制 |
| 托盘应用 | `.dev/app/Daily Agent Digest Dev.app` | `~/.../Daily Agent Digest arm64.app` |
| Bundle ID | `com.daily-agent-digest.tray.dev` | `com.daily-agent-digest.tray` |
| 调度 | 无 launchd 注册(手动启动) | 两个 launchd 服务 |
| 采集数据源 | `.dev/source`(fixture,可 `--source=` 覆盖为真实 HOME) | 真实 `$HOME` |

`dev.sh` 内置保护:如果 dev home 解析到仓库之外、或等于正式版目录,会直接拒绝执行。停止开发版只匹配 `.dev/app/.../DailyAgentDigest` 这一条精确路径,不会误杀正式版或其他应用。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `setup` | 准备 `.dev/`;幂等,可重复执行 |
| `fixtures [--clean]` | 重新生成 fixture 数据源 |
| `test` | `python -m unittest discover -s tests -v` |
| `generate [--live] [--mode=M] [--date=D]` | `clear → generate → 打印 state` |
| `run [--date=D]` | 跑引擎 CLI,输出只读报告文件 |
| `cmd <name> [json] [--mock]` | 调用 app-command 协议 |
| `build` | 只编译开发版 app bundle |
| `app [--demo]` | 编译(自动检测源码是否比 bundle 新)并启动开发版托盘;`--demo` 用 mock 自动生成一次,完整走一遍进度→结果弹窗 |
| `state [--mock]` | 打印 dev `state.json` 摘要 |
| `stop` / `status` / `logs` / `clean` | 停止 / 现状 / 日志 / 清空 `.dev/` |

`generate` 默认走 mock(离线、确定性);`--live` 使用 `.env` 中配置的真实端点。

## UI 冒烟与回归测试

```bash
./native/macos/ui-smoke-test.sh     # 编译 bundle + 运行 --self-test
```

`--self-test` 是无头模式,断言「引擎状态 → 成功/失败」的映射关系(不再需要人工点弹窗):

```
PASS ready state counts as success -> reason=nil
PASS llm fallback (report_status=error) counts as failure -> reason=JSONDecodeError: Expecting value
PASS engine error key counts as failure -> reason=unknown work item id
PASS in-flight state is not success -> reason=生成没有返回可用状态(report_status=generating)
...
```

已接入 CI(`.github/workflows/build-release.yml` 的 macOS job)。

### 查看完整弹窗流程(不需人工点击)

```bash
./scripts/dev.sh app --demo
```

会用 mock LLM 自动生成一次,屏幕上依次出现:非模态进度面板 → 结果弹窗(「查看今日总结」/「关闭」)。日志里可核对整条链路:

```
generation progress panel shown
backend call command=clear      →  backend result command=clear    exit=0
backend call command=generate   →  backend result command=generate exit=0
generation result alert shown items=3
```

## 调试开关(仅开发用)

应用读取两个环境变量,便于无人值守地检查 UI:

| 变量 | 作用 |
| --- | --- |
| `DIGEST_DEBUG_AUTOGENERATE=1` | 启动 1 秒后自动执行一次「生成今日总结」,用来看完整的进度 → 结果弹窗流程 |
| `DIGEST_DEBUG_SHOWREPORT=1` | 启动 1 秒后直接打开报告窗口,用于检查列表渲染 |

```bash
# 直接打开报告窗口检查渲染(配合真实或 mock 数据)
( export DIGEST_ENGINE="$PWD/.dev/bin/dev-engine" DIGEST_HOME="$PWD/.dev/home" \
         DIGEST_SOURCE_ROOT="$PWD/.dev/source" DIGEST_DEBUG=1 \
         DIGEST_DEBUG_LOG="$PWD/.dev/logs/tray.debug.log" DIGEST_DEBUG_SHOWREPORT=1
  "$PWD/.dev/app/Daily Agent Digest Dev.app/Contents/MacOS/DailyAgentDigest" & )
sleep 4 && screencapture -x -o /tmp/digest.png   # 截图核对真实渲染
```

## 已修复:报告正文被截断 / 宽度不铺满(2026-09-12)

现场:报告窗口里每个工作项只显示约一行正文(句中被切断);改用自适应行高后又变成正文只占半宽、`×` 按钮停在窗口中间。

同一个功能踩了三次,最终结论是**不要混用 AppKit 的自动列宽与自动行高**:

| 版本 | 做法 | 结果 |
| --- | --- | --- |
| 1 | 帧布局 + 手写行高公式,公式里用 `table.bounds.width` | 公式与渲染取到不同的宽度,155 字正文只分到 28pt(2 行)却被裁成 1 行 |
| 2 | 改用 `usesAutomaticRowHeights` + Auto Layout 约束 | 单列 `NSTableColumn` 退回默认宽度(约 100pt),正文被挤进约 60pt 窄栏逐字换行 |
| 3 | **单一宽度来源 + 显式列宽 + 帧布局**(当前) | 列宽 = 表格宽(实测 `column=802 body=778`),行高由 `NSLayoutManager` 按同一宽度测量 |

最终实现的三条约束必须同时满足,缺一个就会退化:

1. `contentWidth()` 只从 `table.enclosingScrollView.contentSize` 取值(不依赖表格是否已完成 resize),行高与单元格帧都由它派生;
2. `syncColumnWidth()` 在 `reloadData` 前后各调用一次,并在 `windowDidResize` 中重算,把唯一一列显式设成该宽度,`columnAutoresizingStyle = .noColumnAutoresizing`;
3. 文本高度用 `NSLayoutManager` 测量,不用 `NSAttributedString.boundingRect`。

> 排查提示:两个"看起来合理"的探针都会骗人——`tableView(_:didAdd:forRow:)` 里的 `rowView.frame.height` 是初始默认值(62+6),而 `NSTextField.layout()` 会在 AppKit 的**测量阶段**被调用,记录到的是临时几何。判断渲染是否正确的可靠办法是按屏幕坐标截图核对:`screencapture -x -R x,y,w,h /tmp/shot.png`。

## 设计变更:排除改为「数组过滤」(2026-09-12)

第一版把排除实现成"让 LLM 重写总结、删掉相关句子"。它慢(实测约 10 秒)、要花钱、不可逆(必须额外保存 `summary_full` 才能恢复),而且每次改写结果都不完全一致。

现在的结构是:**日报 = 工作项数组**,每项自带标题与正文,LLM 直接返回 `{title, desc}` JSON:

- 「工作总结」区 = 把**未排除的项**按顺序渲染成「标题 + 内容」;
- 「工作主题」区 = 全部项的索引(标题 + 字数 + ×/恢复),**不重复正文**;
- 排除一项 = 从数组里去掉一项:实测 **106 ms**,不调用 LLM,被排除项的文字原样保留在状态里,所以恢复是免费的、精确的。

状态字段:每项含 `title` / `desc` / `chars` / `excluded`;顶层的 `report_chars`(计入上报的字数)、`included_count`、`excluded_count` 由 `recount_report()` 在每次排除/恢复后重算。已无 `summary` 字段。

`--self-test` 覆盖四条断言:每项都贡献标题与正文、排除一项只移除该项的块、全部排除时报"没有可上报的内容"、字数只统计未排除项。

## 已修复:弹窗卡死(2026-09-12)

现场:成功弹窗里进度条冻结、两个按钮都不显示、弹窗无法关闭,且日志中 `tick` 每 60 秒的记录在弹窗出现后完全停止。

根因有两个,都已在 `native/macos/DailyAgentDigest.swift` 修复:

1. **在运行中的 `NSAlert` 上改结构**:原实现先 `alert.runModal()`,再在完成回调里 `alert.buttons.forEach { $0.isHidden = true }`、`alert.accessoryView = nil` 并 `addButton`。AppKit 不会对已展示的 alert 重新布局,于是旧按钮隐藏后新按钮也不可见,进度条残留。
2. **`runModal()` 阻塞串行主队列**:`sample` 显示进程停在 `-[NSAlert runModal]`,而用 `DispatchQueue.main.async` 排队的 `clear` 调用**始终没有执行**——串行主队列在前一个 block 返回前不会派发下一个。定时器也因注册在 `.default` 模式而不在模态循环中触发。

修复方式:进度改为**非模态 `NSPanel`**(工作完成后关闭),结果用**独立的新 `NSAlert`**;定时器改注册到 `.common` 模式;后端调用不再包在 `DispatchQueue.main.async` 里;并新增超时看门狗与 stderr 捕获。

## 失败注入(用于验证错误路径)

`generate --mode=<mode>` 会把 mock LLM 切到指定行为:

| mode | 行为 | 用于验证 |
| --- | --- | --- |
| `ok` | 返回规范的主题日报 JSON(正文 100–300 字) | 正常链路与长度契约 |
| `verbose` | 故意返回 4 倍超长的标题与正文 | 本地裁剪:总量仍 ≤1000 字、标题 ≤30 字、项数不变 |
| `malformed` | HTTP 200 + 非 JSON 正文 | LLM 返回畸形 → 降级为按 provider 分组、`report_status=error` |
| `error500` | HTTP 500 | 上游失败处理 |
| `hang` | 长时间不响应 | 客户端超时(引擎当前 120s) |

实测(2026-09-12):

```bash
$ ./scripts/dev.sh generate --mode=malformed
  report_status  : error
  last_error     : JSONDecodeError: Expecting value: line 1 column 1 (char 0)
  work_items     : 3
    - [included] codex 工作记录（待 LLM 分类）
    ...
```

这正是需求文档 D-2 描述的现场:引擎已正确置为 `error`,但 Swift UI 只检查返回体的 `error` 键,于是弹窗仍显示「今日总结生成成功」。**开发版可以直接复现这个缺陷**,修完再用同一命令回归。

## 目录结构

```
.dev/
├── home/            # 开发版应用数据:state.json、.env、每日 JSON
├── mock-home/       # 离线 mock 运行专用 home(永不写入真实 key)
├── source/          # fixture 采集源(.codex / .pi / .dsh)
├── bin/dev-engine   # 引擎 wrapper,注入 DIGEST_HOME 等环境变量
├── app/             # 开发版 app bundle
└── logs/            # tray.debug.log、tray.out.log、mock-llm.log
```

## fixture 数据源

`scripts/dev_fixtures.py` 生成三个 provider 的样例数据,覆盖开发所需的边界:

- **codex**:`thread_history_1.sqlite`(6 轮 / 12 条 item)+ `archived_sessions/*.jsonl`(1 条)
- **pi**:`sessions/*.jsonl`(4 条)
- **deepseek-harness**:`sessions/<sid>/*.zstd`(3 条,真实 zstd 压缩)
- 刻意植入的内容:跨 provider **完全重复的一句话**(验证去重折叠)、一条**生活闲聊**(验证 LLM 应排除)、一条**自动化噪音**(验证应排除)、以及 `codex` 归档会话(验证归档读取路径)。

日期默认取当天(UTC+8),可用 `--date=YYYY-MM-DD` 指定。

## 已知的开发期现象

1. 开发版托盘的 `tick` 定时器每 60 秒触发一次。当前时间是 17:30 之后且当天未生成时会触发生成;18:00 后且状态为 `ready` 时会触发 `submit`。由于开发环境**未配置** `DIGEST_FEISHU_WEBHOOK`,当前 `submit` 会把状态错误地置为 `submitted`(需求文档 D-1),这是待修缺陷,不是配置错误。
2. 引擎的 `load_env()` 会用 `.env` 的值覆盖进程环境变量,所以「临时用环境变量改 LLM 端点」不会生效。离线运行请使用 `mock-home`(harness 已内置),而不是 `LLM_BASE_URL=... ./scripts/dev.sh generate`。
3. fixture 中的 Codex session 在真实 LLM 返回里可能被写成 `codex/default` —— 送 LLM 的上下文只带 `[provider] 正文`,不带 session id,模型只能猜。见需求文档 D-18。

## 正式版回滚

正式版文件完整保留(未修改)。如需恢复:

```bash
launchctl enable "gui/$(id -u)/com.daily-agent-digest.tray"
launchctl enable "gui/$(id -u)/com.daily-agent-digest"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.daily-agent-digest.tray.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.daily-agent-digest.plist"
```

或重新执行 `./install.sh` 重装。建议回滚前先确认没有开发版托盘在运行。
