# IDE 类 AI 工具本地对话存储格式调研

> 目的：为「按天汇总用户提示词 + AI 最终回复」的只读采集器确定各数据源的真实路径与字段结构。
>
> **调研环境**：macOS，`~/Library/Application Support/` 下实际安装了 VS Code（含 `github.copilot-chat` 扩展）、Trae CN、TRAE SOLO CN。因此 **VS Code / Copilot / Trae 三类结论来自本机实测 + 官方源码**；Cursor、Windsurf、Zed、Kimi Code、CodeBuddy、Qoder 未在本机安装，结论来自官方文档或社区逆向，已逐条标注把握程度。
>
> **标注约定**：**已证实** = 本机实测或官方文档/官方源码；**推测** = 社区逆向或依据文档推断，未经一手证实。

---

## 结论速览

| 工具 | 路径 | 形态 | 正文是否本地 | 把握程度 |
|---|---|---|---|---|
| **Copilot Chat（VS Code 内置 chat）** | `~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl`；无文件夹窗口在 `globalStorage/emptyWindowChatSessions/` | JSONL 增量变更日志（`kind` 0/1/2/3） | ✅ 是 | 已证实（本机实测 + VS Code 源码） |
| **Copilot 扩展 / Copilot CLI 自己的库** | `~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/session-store.db`；CLI 另有 `~/.copilot/session-store.db` | SQLite（**WAL**），表 `turns` 直接存明文 | ✅ 是（但本机样本极少） | 已证实（本机 schema + 数据 dump） |
| **Cursor** | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | SQLite，表 `cursorDiskKV` | ✅ 是 | 推测（社区逆向，本机未安装） |
| **Qoder** | CLI：`~/.qoder/projects/<project>/<session-id>.jsonl`；IDE：`~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db` | CLI = JSONL；IDE = SQLite | ✅ CLI 是；IDE 部分 | 已证实（CLI 官方文档）／推测（IDE） |
| **Kimi Code** | `~/.kimi-code/`（可被 `KIMI_CODE_HOME` 覆盖） | JSONL 事件流 + JSON | ✅ 是 | 已证实（官方文档）；`wire.jsonl` 行内 schema 未证实 |
| **CodeBuddy（腾讯）** | `~/.codebuddy/`（`projects/`、`sessions/`、`history.jsonl`） | JSONL（Claude Code 同构） | ✅ 是 | 已证实（官方目录文档）／推测（字段 schema） |
| **Trae CN / TRAE SOLO CN** | 会话正文在 `~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db` | 非明文 SQLite（加密/混淆） | ❌ **读不出** | 已证实（本机实测 + 官方论坛） |
| **Windsurf** | `~/.codeium/windsurf/cascade/*.pb` | protobuf | ⚠️ 文件在本地，但无公开 schema | 推测（社区逆向） |
| **Zed** | `~/Library/Application Support/Zed/threads/threads.db` | SQLite，`data` 列为 zstd 压缩 JSON | ✅ 是 | 已证实（Zed 官方源码） |

**一句话取舍**：
- **优先做**：VS Code 内置 chat（`chatSessions/*.jsonl` + `session-store.db` 双源互备）、Zed、Kimi Code、Qoder CLI、CodeBuddy。
- **可以做但成本高**：Cursor（SQLite 可读，但需按 `bubbleId` 前缀重组）、Windsurf（protobuf 需逆向）。
- **不建议做**：Trae CN / TRAE SOLO CN（正文加密，官方明确说不支持）。

---

## GitHub Copilot Chat（VS Code）

**必须区分两个完全独立的存储**：(A) VS Code 内置 chat 运行时写的会话文件；(B) `github.copilot-chat` 扩展 / Copilot CLI 自己维护的 SQLite。

### A. VS Code 内置 chat：`chatSessions/*.jsonl`

- **路径**：
  - 工作区会话：`~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl`
  - **无文件夹的空窗口会话**：`~/Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/<sessionId>.jsonl`
  - 注意 `chatSessions/` 目录在会话存在前**可能根本不存在**（本机 6 个 workspace 里只有 4 个有）。
- **枚举 `<hash>` → 工程目录**：读 `workspaceStorage/<hash>/workspace.json`，取 `folder`（`file://` URI）或 `workspace`。本机实测示例：`fa2543cc59da2ec60dd31ddcb98ebd24` → `file:///Users/mikefox/work/code/mzlc/linmo-pig-full`。
- **形态**：JSONL **增量变更日志**（append-only mutation log），一行一个 op。
- **op 类型（权威定义）**：VS Code 源码 `src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts`：

  ```ts
  const enum EntryKind {
      Initial = 0,   // 首行，完整对象
      Set = 1,       // 属性更新：{kind:1, k:ObjectPath, v}
      Push = 2,      // 数组 push/splice：{kind:2, k:ObjectPath, v?:unknown[], i?:number}
      Delete = 3,    // 删除属性：{kind:3, k:ObjectPath}
  }
  ```

  `ObjectPath = (string | number)[]`。
  **`Push` 的语义是**：*"Pushes 0 or more new entries to an array. If `i` is set, everything after that index is removed"* —— 即 **先截断到索引 `i`，再追加 `v`**。这不是"结束标记"。

  > ⚠️ **重要修正**：任务书里"`{"kind":2}` 是结束标记"的说法**不成立**。本机实测 4 条 `kind:2` 全部带 `k` 和 `v`（其中 2 条还带 `i`），例如
  > `{"kind":2,"k":["requests",0,"response"],"v":[...],"i":6}`
  > 按"结束标记"处理会**丢掉最后一轮 AI 回复**。正确做法是把 0/1/2/3 当作变更 op 顺序重放。

- **正确解析步骤**：

  ```python
  state = None
  for line in open(path):
      e = json.loads(line)
      k, kind = e.get("k"), e["kind"]
      if kind == 0:                      # Initial
          state = e["v"]
      elif kind == 1:                    # Set
          set_path(state, k, e["v"])
      elif kind == 2:                    # Push
          arr = get_path(state, k)
          if e.get("i") is not None:
              del arr[e["i"]:]           # 截断到 i（关键）
          arr.extend(e.get("v") or [])
      elif kind == 3:                    # Delete
          set_path(state, k, None)
  ```

- **会话正文出处**（以下键名来自 `chatSessionOperationLog.ts` 的 `storageSchema`，本机 JSONL 已逐字段核对）：

  | 位置 | 字段 | 说明 |
  |---|---|---|
  | 会话 | `v.sessionId` | 会话唯一 id，等于文件名（UUID） |
  | 会话 | `v.version` | 恒为 `3` |
  | 会话 | `v.creationDate` | 创建时间 |
  | 会话 | `v.customTitle` | 会话标题，**只有用户改过标题时才存在**（源码：`m.hasCustomTitle ? m.title : undefined`） |
  | 会话 | `v.responderUsername` | 形如 `"GitHub Copilot"`，也可能是 `""` |
  | 会话 | `v.initialLocation` | 本机实测为 `"panel"` |
  | 会话 | `v.requests[]` | 每一轮问答 |
  | **用户提示词** | `v.requests[i].message.text` | 纯文本；更细的切片在 `message.parts[].text` |
  | **AI 最终回复** | `v.requests[i].response[]` 中 **没有 `kind` 字段**的项，取 `.value` | 见下方说明 |
  | 时间戳 | `v.requests[i].timestamp` | **epoch 毫秒**（int）。本机样本 `1789711895441` |
  | 时间戳 | `v.requests[i].responseTimestamp` | 同为 epoch 毫秒 |
  | 其他 | `requests[i].modelId`、`requestId`、`responseId`、`promptTokens`、`completionTokens` | `requestId` 形如 `request_<uuid>`，`responseId` 形如 `response_<uuid>` |

- **AI 回复怎么取（最容易踩坑的点）**：`response[]` 是异构数组。markdown 正文项在序列化时被**直接还原成 MarkdownString 的 JSON**，**因此没有 `kind`**——源码 `responsePartSchema`：`(obj) => obj.kind === 'markdownContent' ? obj.content : toJson(obj)`。形状：

  ```json
  {"value": "<markdown 正文>", "supportThemeIcons": false, "supportHtml": false, "baseUri": {"$mid":1,"path":"...","scheme":"file"}}
  ```

  同数组里还有大量**带 `kind`** 的项：`thinking`、`toolInvocationSerialized`、`mcpServersStarting`、`autoModeResolution`、`progressMessage`、`codeblockUri`、`inlineReference`、`warning`、`info`、`treeData`、`undoStop`、`textEditGroup`、`confirmation` 等。
  **注意 `thinking` 项也有 `value`**，所以判定条件必须是"**不含 `kind` 键且 `value` 是字符串**"，不能只判断有没有 `value`。本机样本一輪回复抽出 2 段 markdown（回答被工具调用切成多段），需按顺序拼接。

- **会话索引（用于快速列表，不必解析全部 JSONL）**：SQLite `ItemTable` 的 key `chat.ChatSessionStore.index`，value 是 JSON。**作用域与 JSONL 对齐**：
  - `globalStorage/state.vscdb` 里的 `chat.ChatSessionStore.index` ↔ `globalStorage/emptyWindowChatSessions/`
  - `workspaceStorage/<hash>/state.vscdb` 里的同一 key ↔ 该 hash 的 `chatSessions/`（本机已确认两处都存在此 key）

  条目结构（本机实测）：

  ```json
  {"version":1,"entries":{"<sessionId>":{"sessionId":"...","title":"新建聊天",
   "lastMessageDate":1789711838824,"timing":{"created":1789711838824},
   "initialLocation":"panel","hasPendingEdits":false,"isEmpty":true,
   "isExternal":false,"lastResponseState":1,"permissionLevel":"default"}}}
  ```

  `lastMessageDate` / `timing.created` 均为 **epoch 毫秒**。`isEmpty: true` 表示无内容，可直接跳过。

- **是否可只读打开**：`state.vscdb` 本机 `pragma journal_mode` = `delete`，目录下**没有** `-wal`/`-shm`，**只读打开不会新建 `-shm`**。JSONL 是纯文本，无此问题。
- **来源链接**：
  - [vscode/chatSessionOperationLog.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/chatSessionOperationLog.ts)（`storageSchema`、markdown 序列化）
  - [vscode/objectMutationLog.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts)（`EntryKind` 0/1/2/3）
  - [vscode/chatSessionStore.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts)（`>=1.109 append log`、`.jsonl` 写入）
- **把握程度**：**已证实**（本机实测 21 个 JSONL 文件 + 官方源码交叉验证）。

### B. Copilot 扩展 / Copilot CLI 自己的 `session-store.db`

**这是比 JSONL 干净得多的数据源**——用户提问和 AI 回复就是两个明文 TEXT 列。

- **路径**：
  - VS Code 扩展：`~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/session-store.db`
  - Copilot CLI / App：`~/.copilot/session-store.db`（本机存在 `~/.copilot/{config.json,ide/,logs/}`）
- **形态**：SQLite，`schema_version = 3`。表：`sessions`、`turns`、`checkpoints`、`session_files`、`session_refs`、`search_index`(FTS5)。
- **正文位置 = `turns` 表**（官方建的 schema，字段名如下，逐字准确）：

  | 表.列 | 说明 |
  |---|---|
  | `turns.user_message` | **用户提示词，明文 TEXT** |
  | `turns.assistant_response` | **AI 最终回复，明文 TEXT**（可能为空字符串，表示该轮还在进行或未产出） |
  | `turns.timestamp` | `TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` → **ISO-8601 UTC 字符串**，如 `2026-09-11T06:06:15.491Z` |
  | `turns.session_id` / `turns.turn_index` | 外键 + 轮次序号，`UNIQUE(session_id, turn_index)` |
  | `sessions.id` | 会话唯一 id（UUID） |
  | `sessions.cwd` | 工程目录绝对路径 |
  | `sessions.repository` | 仓库 URL（可能为空串） |
  | `sessions.branch` | 分支名 |
  | `sessions.host_type` | 本机实测 `vscode` |
  | `sessions.agent_name` | 本机实测 `GitHub Copilot Chat` / `Inline Chat` |
  | `sessions.summary` | 该会话首轮的用户提问（作为摘要） |
  | `sessions.created_at` / `updated_at` | ISO-8601 UTC 字符串 |

  索引：`idx_turns_session`、`idx_sessions_repo`、`idx_sessions_cwd`。另有 FTS5 全文表 `search_index(content, session_id, source_type, source_id)`，`content` 是"提问+回复"拼接，可直接做关键词检索。

- **时间戳**：ISO-8601 字符串（`...Z`），不是毫秒。
- **会话 id**：`sessions.id`；轮次级唯一键 `(session_id, turn_index)`。
- **⚠️ 是否可只读打开**：**这是 WAL 库**。本机 `session-store.db` 主文件仅 4096 字节，而 `-wal` 有 251 KB —— **数据几乎全在 WAL 里**。
  - 用 `immutable=1` 打开会**得到空 schema**（本机实测复现），必须用 `mode=ro`（会读取 WAL）。
  - WAL 库只读打开**需要 `-shm`**；若 `-shm` 不存在（例如 App 正退出后清理过），SQLite 会在**同目录新建 `-shm`**。稳妥做法：把 `session-store.db`、`-wal`、`-shm` **三个文件一起复制到临时目录再读**，避免写进应用目录。
- **来源链接**：本机 schema dump（`sqlite3 .schema`）；[tokentracker 对 `~/.copilot/session-store.db` 的说明](https://cdn.jsdelivr.net/npm/tokentracker-cli@0.89.0/README.zh-CN.md)
- **把握程度**：**已证实**（本机 schema + 真实数据行 dump）。**但注意样本量**：本机仅 2 个 session / 2 个 turn，说明该库是较新机制或仅覆盖部分会话类型（含 Inline Chat），**不能单独依赖，应与 A 的 JSONL 合并去重**。

---

## Cursor

- **路径**：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **形态**：SQLite。两个表：`ItemTable(key TEXT, value BLOB)`、`cursorDiskKV(key TEXT, value BLOB)`。
- **正文位置**：**`cursorDiskKV`**，key 前缀 `bubbleId:`：
  - `bubbleId:<composerId>:<messageId>` → **消息 JSON**，含 `text`/`content`、`type`、`createdAt`、`bubbleId`
  - `messageRequestContext:<composerId>:<messageId>` → 上下文元数据，**通常无正文**
- **消息结构**：`type` 作为角色判别 —— **`1` = 用户，`2` = 助手**。按 `composerId`（`bubbleId:` 后第一个字段）分组、按 `createdAt` 或 messageId 排序即可重组会话。
- **工作区库**：`workspaceStorage/<hash>/state.vscdb` 的 `ItemTable` 里是 `aiService.prompts`、`aiService.generations`、`composer.composerData`、`history.entries` —— 逆向结论是**这些只是 prompt/生成元数据，不含消息正文**；正文集中在上面的全局 `cursorDiskKV`。
- **会话 id**：`composerId`。
- **时间戳**：`createdAt`。
- **来源链接**：[SimHacker/moollm — Cursor storage map (macOS)](https://github.com/SimHacker/moollm/blob/main/skills/cursor-mirror/reference/reverse-engineered/storage/MAC-STORAGE.yml)
- **把握程度**：**推测**（社区 SQLite 逆向；本机未安装 Cursor，无法验证）。全局库体积可达数 GB，扫描时务必用 `WHERE key LIKE 'bubbleId:%'` 下推，避免全表读入内存。

---

## Qoder

**需要区分 CLI 与 IDE**，两者存储完全不同。

### Qoder CLI（官方文档明确）

- **路径**：`~/.qoder/projects/<processed-project-path-name>/<session-id>.jsonl`（**对话日志**）
  以及 `~/.qoder/projects/<processed-project-path-name>/<session-id>/state.json`（会话状态）
- **配置根目录**：默认 `~/.qoder`，可用环境变量 **`QODER_CONFIG_DIR`** 覆盖 —— 采集时需读该变量。
- **形态**：JSONL（正文）+ JSON（状态）。
- **会话 id**：`<session-id>`，即文件名；支持 `--session-id` 指定。
- **正文位置**：`.jsonl` 内为"你的输入、Qoder 的回复、工具调用"的完整历史。**行内字段级 schema 官方未公开**，实现前需先 dump 一个真实文件确认。
- **来源链接**：[Qoder CLI — Session Management（官方）](https://docs.qoder.com/cli/sessions.md)
- **把握程度**：路径与形态 **已证实**（官方文档）；行内字段 **未证实，属推测**。

### Qoder IDE（VS Code 分支）

- **路径**：`~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db`（SQLite）
- **正文情况**：采集工具 [TokenTracker] 对此库**只读取 assistant 的 `token_info`**，并明确声明"**不读取提示词或回复**"。这暗示库里确实有 assistant 侧消息记录（含 token 计数），但**是否含完整正文未经证实**。
- **本机**：仅存在 `~/.qoder/skills`、`~/.qoder-cn/skills`，未安装 Qoder IDE，无法实测。
- **来源链接**：[TokenTracker README（Qoder 一行）](https://cdn.jsdelivr.net/npm/tokentracker-cli@0.89.0/README.zh-CN.md)、[Qoder Sync（VS Code 市场扩展，"Qoder 缓存数据库采集工具"）](https://marketplace.visualstudio.com/items?itemName=zkjn-qoder-sync.zkjn-qoder-sync)
- **把握程度**：**推测**。建议实现前先本机 dump `local.db` 的 `.tables` 与关键表前几行。

---

## Kimi Code

**不是 VS Code 分支**。月之暗面提供三套东西：Kimi Code CLI、Kimi Code Desktop、以及「Kimi Code for VS Code」扩展，均**有官方文档**。

- **路径（官方）**：数据根目录 `~/.kimi-code/`，可被 **`KIMI_CODE_HOME`** 环境变量整体覆盖（采集时需读该变量）。

  ```
  ~/.kimi-code/
  ├── session_index.jsonl          # 会话索引
  ├── sessions/<workDirKey>/<sessionId>/
  │   ├── state.json               # 元数据：title、lastPrompt、创建/更新时间、forkedFrom
  │   └── agents/main/wire.jsonl   # ★ 主 Agent 完整通信记录
  │       agents/<subagentId>/wire.jsonl  # 子 Agent 各自的记录
  └── user-history/<md5(workDir)>.jsonl   # 终端输入历史（就是用户提示词）
  ```

  - `workDirKey` 格式：`wd_<slug>-<sha256 前 12 位>`（官方描述：`wd_<slug>_<first-12-chars-of-sha256>`）
  - 官方另注：`~/.kimi/sessions/**/wire.jsonl` 是旧/别名根目录（[TokenTracker](https://cdn.jsdelivr.net/npm/tokentracker-cli@0.89.0/README.zh-CN.md) 仍按 `~/.kimi/` 采集），实现时**两个根目录都要探测**。
- **形态**：JSONL（`session_index.jsonl`、`wire.jsonl`、`user-history/*.jsonl`）+ JSON（`state.json`）。
- **正文位置**：`agents/main/wire.jsonl`。官方定性为 **"agent event stream, used for session recovery and replay"**，并说明还包含 request trace（发给模型的 tool schema、请求参数、MCP 列表）。
  > ⚠️ 因为它是**事件流**，不能假设"一行一条消息"。解析必须先按 `type`/`event` 之类的事件判别字段分流，只取用户消息与 assistant 最终文本事件。
- **会话 id**：`sessionId`（= `sessions/<workDirKey>/<sessionId>/` 目录名）；`session_index.jsonl` 每行含 `sessionId`、`sessionDir`、`workDir`（官方明确）。
- **时间戳**：`state.json` 里的创建/更新时间；`wire.jsonl` 事件时间戳 **未证实**。
- **来源链接**：
  - [Kimi Code Docs — Data locations（官方）](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
  - [Kimi Code Docs — Sessions and context（官方）](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
  - 源码仓库：[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
- **把握程度**：**路径/目录结构/文件职责已证实**（官方文档）；**`wire.jsonl` 行内字段 schema 未证实，属推测** —— 实现前必须 dump 真实文件。

---

## CodeBuddy（腾讯）

- **路径（官方目录文档）**：`~/.codebuddy/`

  ```
  ~/.codebuddy/
  ├── settings.json / settings.local.json / CODEBUDDY.md / mcp.json
  ├── projects/        # 各项目的会话与子代理运行时数据
  ├── sessions/        # 会话数据
  ├── plans/           # 计划模式生成的计划文件
  ├── history.jsonl    # ★ 对话历史
  ├── file-history/    # 文件变更历史
  ├── logs/ traces/ blobs/ local_storage/ tasks/ teams/ shell-snapshots/ skills/ agents/ rules/
  ```

- **形态**：JSONL。CodeBuddy Code 是 **Claude Code 的 fork**（TokenTracker 明确标注），因此 `projects/**/*.jsonl` 与 `sessions/` 的布局**很可能与 `~/.claude/projects/<编码后的路径>/<session-uuid>.jsonl` 同构**；同生态的 WorkBuddy 也是"SessionEnd hook + 被动扫描 `projects/**/*.jsonl`"。
- **正文位置**：`history.jsonl`（官方标注 "对话历史"）与 `projects/**/*.jsonl`、`sessions/`。**三者中哪个承载完整正文，官方文档未细化**。
- **会话 id**：官方未给出字段名；按 Claude Code 同构推测为会话文件名/`sessionId`。
- **时间戳**：官方未给出。
- **本机实测**：`~/.codebuddy/` 下**只有** `diagnostics/`、`logs/memwatch/`、`skills/` —— **没有 `projects/`、`sessions/`、`history.jsonl`**。即本机只装过 CodeBuddy 的 CLI（且只用了 skills），从未产生会话。另外 `~/Library/Application Support/CodeBuddyExtension/` 下只有 `Data/Public/auth/`，**不含对话**。
- **来源链接**：
  - [.codebuddy 目录结构说明（官方）](https://www.codebuddy.ai/docs/cli/codebuddy-dir)
  - [腾讯云镜像同一文档](https://cloud.tencent.com/document/product/1831/137016)
  - [TokenTracker — CodeBuddy = Claude-Code fork](https://cdn.jsdelivr.net/npm/tokentracker-cli@0.89.0/README.zh-CN.md)
- **把握程度**：**目录结构已证实**（官方）；**对话文件的字段级 schema 未证实，属推测**。注意本机无样本，需在有真实会话的机器上先 dump。

---

## Trae / TRAE SOLO（字节）

**结论：GUI 对话正文在本地读不出来，不建议做。**

### 实测否证（本机）

| 检查项 | 结果 |
|---|---|
| `Trae CN/User/workspaceStorage/*/chatSessions/` 目录 | **不存在**（7 个 workspace 全都没有） |
| `globalStorage/state.vscdb` 的 `chat.ChatSessionStore.index` | 值为 `{"version":1,"entries":{}}` —— **空** |
| `TRAE SOLO CN` 同 key | 同样为空 |
| workspace `state.vscdb` 里最大 value | `workbench.panel.viewContainersWorkspaceState` = **524 字节** |
| global `state.vscdb` 里 AI 相关最大 value | `1317686273377321:AI.agent.model.model_list_map` = **290071 字节**（模型清单，非对话） |
| AI 相关 key 总数 | 49 个，全是 UI 状态 / 模型映射 / 迁移标记（`ai.config.autoRun.migration.*`、`workflow.*` 等） |

> **对任务书「AI 相关 value 最大只有 524 字节」的核对**：**数字对得上，但对象不对**。524 字节那条是 `workbench.panel.viewContainersWorkspaceState`（**UI 面板布局**，不是 AI 值）；而 global 库里 AI 相关最大 value 其实是 **290 KB**（`AI.agent.model.model_list_map`，模型目录）。**"本地只有元数据"这个结论仍然成立，但理由不是"值都很小"**，而是：`ChatSessionStore.index` 为空、`chatSessions/` 目录不存在、正文另存于加密库（见下）。

### 真正的会话库：加密，读不出

- **路径**：`~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db`（另有 `-wal` 7.6 MB、`-shm`；TRAE SOLO CN 对应文件 28 MB）
- **实测格式判定**：
  - `head -c 16` = `b5661d7f72a38eacc607888d8cccd5d6…`，**没有 `SQLite format 3\0` 头**
  - 前 200 KB 的 **256 种字节值全部出现**（均匀高熵），`strings -n 6` 命中 **0** 个 `message|session|prompt|conversation` 关键词
  - `sqlite3` 直接报 `file is not a database`
  - 同目录 `ModularData/ckg_server/env_codekg.db`、`Local Storage/config.db` 同样是**无 SQLite 头的二进制块**
  - → 判定为**加密/混淆存储（类 SQLCipher，或自有加密格式）**，只读解析不可行。
- **官方口径（重要佐证）**：TRAE 官方论坛中，**TRAE 技术支持明确答复"暂不支持查找到对话记录的源文件，可以将对话导出"**；同一帖里 TRAE 官方账号则把用户指向 `ModularData/ai-agent/database.*`（"这里的 database.* 文件就是存储所有 AI 会话记录的地方"）。
  链接：[找不到 solo 模式下大模型返回的具体会话记录 — TRAE 官方中文社区](https://forum.trae.cn/t/topic/21258)
- **另一条佐证**：论坛另有 `database.db` 损坏导致"会话数据全没了"的修复求助帖，说明该库确实是会话唯一载体。
  链接：[TRAE database.db 损坏 会话数据全没了的修复办法](https://forum.trae.cn/t/topic/169594)

### 唯一可读的 Trae 数据：CLI/agent 的**语义摘要**（非原文）

- **路径**：`~/.trae-cn/memory/projects/<project-slug>/<YYYYMMDD>/session_memory_<id>.jsonl`
  （`~/.trae` 是另一份；`/usr/local/bin/trae-cn` 软链到 `Trae CN.app`，说明 `~/.trae-cn` 属 Trae 的 CLI/agent 侧）
- **形态**：JSONL，**每个文件是某个会话的逐条"记忆摘要"**。本机实测单行：

  ```json
  {"intent":"安装 t-a1i/archify 技能",
   "actions":["安装 archify 技能","验证技能文件完整性"],
   "outcome":"成功安装 archify 技能至 ~/.trae-cn/skills/archify/，需重启会话生效",
   "learned":["用户输入的 t-a1i 不存在，实际安装的是 tt-a1i/archify","..."],
   "message_summary_time":"2026-09-27 17:31:31",
   "message_id":"6ab8e1f389d2964e7c788a52",
   "compact_summary_meta":{"trigger":"auto","mode":"async",
     "server_history_id":"6ab8e1f389d2964e7c788a52",
     "summary_digest":"7861704bfc3f2d110381d90339d690c8df8ebc5aecb1a2d8d155f1b3bbacd301",
     "created_at_ms":1790501491445}}
  ```

  - 字段：`intent`、`actions[]`、`outcome`、`learned[]`、`message_summary_time`（**本地时间字符串 `YYYY-MM-DD HH:MM:SS`，非 ISO**）、`message_id`、`compact_summary_meta.{trigger,mode,server_history_id,summary_digest,created_at_ms}`（`created_at_ms` 是 **epoch 毫秒**）
  - 同目录 `topics.md`：每行 `[session_id: <id> | topic_summary_time: <YYYY-MM-DD HH:MM:SS>] <主题摘要>`
- **⚠️ 用途限制**：这是**模型生成的语义摘要**，**不是**"用户提示词 + AI 最终回复"原文。而且 `compact_summary_meta` 里带 `server_history_id`、`summary_digest`，进一步印证**正文与历史在服务端**。它可以用于日报的"今日做了什么"，**不能**当作对话正文来源。

- **会话 id**：`message_id`（单条摘要）；会话级 id 在 `topics.md` 的 `session_id`。
- **来源链接**：本机实测 + [TRAE 官方论坛帖](https://forum.trae.cn/t/topic/21258)
- **把握程度**：**已证实**（本机实测 + 官方论坛答复）。本机路径为 `Trae CN` / `TRAE SOLO CN`；国际版目录名可能是 `Trae` / `TRAE SOLO`，采集时需一并探测。

---

## Windsurf

- **路径**：`~/.codeium/windsurf/cascade/*.pb`，以及 `~/.codeium/windsurf/implicit/*.pb`
- **形态**：**protobuf**（二进制 `.pb` 轨迹文件），**无公开 schema**。官方 AI 扩展为 `codeium.windsurf`；Cascade 与语言服务器之间走 gRPC-over-HTTP/1.1。
- **正文位置**：Cascade trajectory `.pb` 文件本身。社区逆向结论：**"The authoritative session data lives in the shared Cascade `.pb` files, not in state.vscdb"** —— 即 `~/Library/Application Support/Windsurf/User/{globalStorage,workspaceStorage}/state.vscdb` 里的 `chat.ChatSessionStore.index`、`agentSessions.model.cache`、`agentSessions.state.cache` **都是空的**，正文**只在 `.pb` 里**。
- **注意同一格式的另一家**：Cognition 收购后的 **Devin 桌面端是 Windsurf 的 rebrand fork**，写同一批 `~/.codeium/windsurf/cascade/*.pb`。因此**文件本身不带可靠的来源标识**，无法从文件区分是 Windsurf 还是 Devin 产生的。
- **会话 id**：trajectory id（文件名）。
- **时间戳**：**未证实**（protobuf 内部字段）。
- **来源链接**：
  - [Devin & Windsurf Session Storage (Shared Cascade Format)](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/logFilesSchema/devin-windsurf-session-format.md)
  - [WindsurfAPI — 从启动入口读完整个 WindsurfAPI](https://dwgx.github.io/WindsurfAPI/review.html)
- **把握程度**：**推测**（社区逆向，本机未安装 Windsurf）。要做的话需要自己用 `protoc --decode_raw` 逐字段逆推，成本较高；且逆向结论认为这些 `.pb` 里既有 `data_type` 类似信息也有完整轨迹，**需先验证是否真含可读正文再排期**。

---

## Zed

**这是除 VS Code 外唯一有官方源码背书的完整方案。**

- **路径**：`~/Library/Application Support/Zed/threads/threads.db`
  （官方源码 `crates/agent/src/db.rs`：`paths::data_dir().join("threads").join("threads.db")`）
- **形态**：SQLite。表 `threads`（官方 `CREATE TABLE`，字段名逐字准确）：

  ```sql
  CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data_type TEXT NOT NULL,
      data BLOB NOT NULL
  )
  -- 后续 ALTER 追加：parent_id、folder_paths、folder_paths_order、created_at
  ```

- **正文位置**：**`threads.data` 这一列 BLOB**，其中 `data_type` 决定编码：
  - `'zstd'` → **zstd 压缩的 JSON**（现行格式；源码 `zstd::encode_all(json, COMPRESSION_LEVEL)`）
  - `'json'` → 未压缩 JSON（旧数据；两种都要支持）
- **解压后的消息结构**（官方源码 `crates/agent/src/legacy_thread.rs`）：
  - 顶层 `SerializedThread { version, messages: SerializedMessage[] }`
  - `SerializedMessage { role: Role, segments: SerializedMessageSegment[], context: String, ... }`
  - `SerializedMessageSegment` 是 `#[serde(tag = "type")]` 的枚举：
    - `#[serde(rename = "text")] Text { text }` → **正文在这里**
    - `#[serde(rename = "thinking")] Thinking { ... }` → 思维链，**不是**正文，需排除
  - 工具调用：`SerializedToolUse { input }`、`SerializedToolResult { content, output }`
  - 旧格式另有 `LegacySerializedThread { messages: LegacySerializedMessage[] }`，其 `LegacySerializedMessage { role, text }` 直接给 `role` + `text` 两个字段
- **消息角色**：`role`（`language_model::Role`，`User` / `Assistant`）
- **时间戳**：`threads.updated_at`、`threads.created_at`，均为 **TEXT**（ISO-8601 风格；源码有 `UPDATE threads SET created_at = updated_at WHERE created_at IS NULL`）。注意：**线程内部的逐条消息没有时间戳**，社区工具只能用线程级 `updated_at` 近似（长会话内跨天归属会不准）。
- **会话 id**：`threads.id`。
- **是否可只读打开**：`threads.db` 由 Zed 自己的 `Connection::open_file` 打开；**官方源码未设置显式 WAL pragma**，但采集侧仍应以 `mode=ro` 打开，并注意 `-wal`/`-shm` 可能出现。BLOB 解压用 Node 内置 `zlib.zstdDecompressSync`（Node 22.15+）或任意 zstd 库。
- **来源链接**：
  - [zed/crates/agent/src/db.rs](https://github.com/zed-industries/zed/blob/main/crates/agent/src/db.rs)（建表、`DbThread`、zstd 编解码）
  - [zed/crates/agent/src/legacy_thread.rs](https://github.com/zed-industries/zed/blob/main/crates/agent/src/legacy_thread.rs)（`SerializedMessage`、`SerializedMessageSegment`、serde tag）
  - [codeburn — Zed provider 文档](https://github.com/getagentseal/codeburn/blob/main/docs/providers/zed.md)
- **把握程度**：**已证实**（Zed 官方源码；本机未安装 Zed，但 schema 与字段名均来自上游源码）。

---

## 不建议做的

| 工具 | 理由 |
|---|---|
| **Trae CN / TRAE SOLO CN** | **正文读不出来，且官方明确不支持**。① GUI 侧 `chat.ChatSessionStore.index` 实测为空、`chatSessions/` 目录不存在；② 真实会话库 `ModularData/ai-agent/database.db` **无 SQLite 头、全字节均匀高熵、零明文关键词 → 加密存储**，`sqlite3` 直接报 `file is not a database`；③ TRAE 技术支持在官方论坛答复"**暂不支持查找到对话记录的源文件，可以将对话导出**"；④ 唯一可读的 `~/.trae-cn/memory/**/session_memory_*.jsonl` 是**模型生成的语义摘要（intent/actions/outcome/learned）**，不是"用户提示词 + AI 最终回复"原文，且带 `server_history_id` / `summary_digest`，印证正文在服务端。**代价与收益完全不成比例。** |

### 建议降级/缓做的

| 工具 | 情况 |
|---|---|
| **Windsurf** | 正文确实在本地 `~/.codeium/windsurf/cascade/*.pb`，但是 **protobuf 且无公开 schema**，需自行逆向；且与 Devin 桌面端**共用同一目录、文件内无来源标识**，无法区分来源。**建议先做一个"只验证 `*.pb` 里能否解出可读文本"的时间盒探针再决定。** |
| **Cursor** | 技术可行（`cursorDiskKV` 里 `bubbleId:` 前缀就是消息 JSON，`type` 1/2 区分角色），但：全局 `state.vscdb` 体积可达 **数 GB**，且结论只有**社区逆向**支撑（官方零文档），字段名可能随版本变化。**建议做，但必须先在有 Cursor 的机器上实测 dump 验证 `bubbleId` value 的真实字段名。** |
| **Qoder IDE / CodeBuddy** | 路径与目录结构有官方文档背书，但**对话文件的字段级 schema 均无权威来源**。**建议实现前先各 dump 一个真实会话文件确认字段，再写 parser。** |
| **Copilot 扩展 `session-store.db`** | 结构最干净（`turns.user_message` / `turns.assistant_response` 明文），但本机只有 2 条记录，**覆盖面明显小于 JSONL**。**建议作为补充源，不要替代 `chatSessions/*.jsonl`。** |

---

## 附：只读采集的通用注意事项

1. **WAL 库必须连 `-wal` 一起读**：`immutable=1` 会**忽略 WAL 并返回空 schema**（在 `github.copilot-chat/session-store.db` 上实测复现）。原因为主库只有 4096 字节、数据几乎全在 `-wal`。
2. **避免在应用目录里建 `-shm`**：WAL 库只读打开需要 `-shm`，缺失时会在**同目录新建**。最稳的做法是把 `*.db` + `-wal` + `-shm` **三个文件一起复制到临时目录**再打开。
3. **非 WAL 库不建 `-shm`**：VS Code 的 `state.vscdb` 实测 `journal_mode=delete`、目录下无 `-wal`/`-shm`，`mode=ro` 打开是干净只读。
4. **先判 `-wal` 是否存在**再决定读取策略；**永远用 `mode=ro`，不要用 `immutable=1`**（会静默漏数据）。
5. **Trae 的 `.db` 不要试图当 SQLite 打开**：先校验文件头 `SQLite format 3\0`，否则直接跳过，避免把加密块误当损坏库。
6. **路径探测要覆盖变体**：`Code` / `Code - Insiders`；`Trae` / `Trae CN` / `TRAE SOLO` / `TRAE SOLO CN`；`Qoder` / `Qoder CN`；并读取 `KIMI_CODE_HOME`、`QODER_CONFIG_DIR` 等环境变量覆盖的数据根。
7. **Zed 的 `data` 是 BLOB 不是 TEXT**：SQLite 里取出来是 `bytes`，需先判 `data_type`（`zstd`/`json`）再解压，不要直接 `json.loads`。
8. **VS Code JSONL 必须按 op 重放**，且 **`kind:2` 是 Push（截断到 `i` 再追加），不是结束标记**；`thinking` 项也带 `value`，取 AI 正文的判据是"**无 `kind` 键且 `value` 为字符串**"。

---

## 来源汇总

**官方文档 / 官方源码**

- [VS Code `chatSessionOperationLog.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/chatSessionOperationLog.ts)
- [VS Code `objectMutationLog.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts)
- [VS Code `chatSessionStore.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/chatSessionStore.ts)
- [Zed `crates/agent/src/db.rs`](https://github.com/zed-industries/zed/blob/main/crates/agent/src/db.rs)
- [Zed `crates/agent/src/legacy_thread.rs`](https://github.com/zed-industries/zed/blob/main/crates/agent/src/legacy_thread.rs)
- [Kimi Code — Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
- [Kimi Code — Sessions and context](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
- [Qoder CLI — Session Management](https://docs.qoder.com/cli/sessions.md)
- [CodeBuddy — .codebuddy 目录结构说明](https://www.codebuddy.ai/docs/cli/codebuddy-dir)（[腾讯云镜像](https://cloud.tencent.com/document/product/1831/137016)）
- [TRAE 官方论坛 — 找不到 solo 模式下大模型返回的具体会话记录](https://forum.trae.cn/t/topic/21258)
- [TRAE 官方论坛 — database.db 损坏 会话数据全没了](https://forum.trae.cn/t/topic/169594)
- [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)

**社区逆向 / 第三方采集工具**

- [SimHacker/moollm — Cursor storage map (macOS)](https://github.com/SimHacker/moollm/blob/main/skills/cursor-mirror/reference/reverse-engineered/storage/MAC-STORAGE.yml)
- [Devin & Windsurf Session Storage (Shared Cascade Format)](https://github.com/rajbos/ai-engineering-fluency/blob/main/docs/logFilesSchema/devin-windsurf-session-format.md)
- [WindsurfAPI 源码分析](https://dwgx.github.io/WindsurfAPI/review.html)
- [codeburn — Zed provider](https://github.com/getagentseal/codeburn/blob/main/docs/providers/zed.md)
- [TokenTracker README（31 款工具本地路径速查）](https://cdn.jsdelivr.net/npm/tokentracker-cli@0.89.0/README.zh-CN.md)
- [copilot-session-tools Issue #38 — VS Code JSONL append-log 格式](https://github.com/Arithmomaniac/copilot-session-tools/issues/38)
- [Qoder Sync（VS Code 市场扩展）](https://marketplace.visualstudio.com/items?itemName=zkjn-qoder-sync.zkjn-qoder-sync)
