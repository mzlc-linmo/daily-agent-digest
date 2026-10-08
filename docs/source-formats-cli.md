# 命令行类 AI agent 本地对话存储格式调研

> 目的：为「日报工具」新增只读数据源提供**可直接照抄的路径与字段**。
> 采集目标固定为两件事：**用户提示词** + **AI 最终回复**，按天汇总。
>
> 本文所有结论分两级：**已证实**（官方文档 / 官方源码 / 本机实测）与 **推测**（明确写出依据）。
> 查不到的条目一律写「未找到」，不编造路径。**附录 B 用一句话给出「该不该做」的建议。**

调研日期：2026-10-08（本机时区 Asia/Shanghai）
调研方式：macOS 本机实测（`~/.claude`、`~/.codex`、`~/.dsh`、`~/.qwen`、`~/.workbuddy-ai` 等真实目录）+ 官方文档 / GitHub 源码取证。

## 采集端通用纪律（先读这一节）

1. **只读、只取文本字段。** 这些文件里混有明文密钥：本机 `~/.dsh` 的会话日志中确实出现过
   `Authorization: Bearer <token>` 形式的字符串（在用户自己粘贴的内容里）。因此采集端**必须**
   只按字段路径取文本，且**不要把整行原始 JSON 落库或上传**。
2. **不要试图反解目录名。** 各家的「工作目录 → 目录名」编码都是有损的（见下），并且编码规则随版本变过。
   一律：glob 出所有会话文件 → 从文件内记录的 `cwd` 字段拿真实工作目录。
3. **注意「同一逻辑消息被写成多行」。** Claude Code / Gemini CLI 都会把一条助手消息拆成多条
   JSONL（每个 content block 一行，或后续修正重写）。取文本必须按消息 id 聚合去重，否则会重复计数。
4. **注意「注入内容不是用户提示词」。** 各家的会话文件里都混有系统提示、环境快照、上下文注入、
   压缩摘要、工具结果。这些在 Claude Code / DSH / Qwen Code 里都有显式标记（`isMeta`、
   `source.kind`、`subtype`、`provenance`），必须过滤，否则日报里会全是脚手架文本。
5. **zstd / protobuf 需要额外解码。** DSH 是 zstd 包 JSONL；Devin 桌面版是 protobuf。

---

## 结论速览

| 工具 | macOS 路径 | 形态 | 把握程度 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<编码cwd>/<sessionId>.jsonl` | JSONL | 已证实（第三方多来源实测一致） |
| Gemini CLI | `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl` | JSONL | 已证实（官方文档 + 官方源码） |
| Qwen Code | `~/.qwen/tmp/<project_hash>/chats/` | JSONL | 路径推测（fork 自 Gemini CLI）/ 记录字段已证实（源码） |
| 豆包 Doubao | 无「Doubao CLI」本地会话；官方命令行 agent 是 **veCLI** `@volcengine/vecli` | 未知 | 存储路径**未找到公开信息** |
| DeepSeek CLI | `~/.dsh/sessions/<slug>/<session-id>/session[.vN].jsonl.zstd` | zstd(JSONL) | 已证实（本机实测 + 官方仓库） |
| Kimi CLI / Kimi Code | `~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`（旧版 `~/.kimi/sessions/<md5(cwd)>/<sid>/`） | JSONL | 已证实（官方文档 + 官方源码） |
| OpenCode | `~/.local/share/opencode/project/<slug>/storage/`（含 `opencode.db`） | SQLite / JSON | 顶层目录已证实；文件级结构推测 |
| OpenClaw | `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`（归档 `.../sessions/`） | SQLite | 已证实（官方文档） |
| Paperclip | 自托管服务的数据库（部署相关） | 服务器 DB | **不是本地 CLI 会话文件**；不建议做 |
| Hermes Agent | `~/.hermes/state.db` | SQLite | 已证实（官方开发者文档） |
| Devin Desktop | `~/.codeium/windsurf/cascade/*.pb`（与 Windsurf 共用） | protobuf | 已证实但**不建议做**（见该节） |
| WorkBuddy | `~/.workbuddy-ai/projects/<编码cwd>/<session-uuid>.jsonl` + `~/.workbuddy-ai/workbuddy.db` | JSONL + SQLite | 已证实（本机实测 schema） |

---

## Claude Code

- **路径**：`~/.claude/projects/<编码后工作目录>/<sessionId>.jsonl`
  - 子 agent（Task 工具）：`~/.claude/projects/<编码cwd>/<session-id>/subagents/agent-<agentId>.jsonl`，
    同名 `.meta.json` 含 `{"agentType","description","toolUseId"}`。
  - 全局输入历史：`~/.claude/history.jsonl`（每行 `display` / `pastedContents` / `timestamp` / `project`）。
  - 其他可能存在的目录：`~/.claude/transcripts/ses_*.jsonl`、`~/.claude/pre-compact-session-histories/*.jsonl`。
  - 目录名编码（**有损**）：`/Users/neil/xuku/invoice` → `-Users-neil-xuku-invoice`；Windows 上另有
    `C--Users-alice-Desktop-myapp` 的写法。**不要反解**，读文件内 `cwd`。
- **形态**：JSONL，一行一个 JSON 对象 = 一个事件。
- **正文位置**：
  - 用户：`type=="user"` 且 `message.content` 为**字符串**时才是真人输入；为**数组**时几乎都是
    `tool_result`（工具结果回灌），不是提示词。
  - 助手：`type=="assistant"` 的 `message.content[]` 里 `type=="text"` 的 `text`。
- **消息结构（用户/助手）**：
  - 公共信封：`uuid`, `parentUuid`, `sessionId`, `cwd`, `version`, `gitBranch`, `timestamp`,
    `isSidechain`(bool), `isMeta`(bool，可能缺失), `type`。
  - 用户：`{"type":"user","message":{"role":"user","content":"<提示词>"}, ...}`；带工具结果时会额外有
    顶层 `toolUseResult`（`stdout`/`stderr`/`interrupted`/`isImage`…）。
  - 助手：`{"type":"assistant","requestId":"req_...","message":{"id":"msg_...","model":"claude-opus-4-7",
    "role":"assistant","content":[{"type":"thinking",...},{"type":"text","text":"..."},
    {"type":"tool_use","id":"toolu_...","name":"Bash","input":{...}}],
    "stop_reason":"tool_use"|"end_turn"|null,"usage":{"input_tokens":...,"output_tokens":...}}}`
  - **只取文本**：过滤 `message.content[]` 中 `type=="text"`；丢 `thinking` / `tool_use`。
  - **必须去重**：一条 API 消息被拆成多行 JSONL，每行 `message.id` 相同、`usage` 逐字节相同
    （实测 7166 条 assistant 行 → 2708 个唯一 `message.id`）。按 `message.id` 聚合后再拼 `text`，
    否则文本重复、token 约 2.6 倍虚高。
  - **过滤注入**：`isSidechain==true`（子 agent 流量）、`isMeta==true`、`content` 以 `<` 开头
    （`<command-name>`、`<system-reminder>`…）、`isCompactSummary==true`、
    以及 `[Request interrupted by user]` / `[Request interrupted by user for tool use]` 这类中断标记。
  - 其他 `type` 值（忽略即可）：`summary`（首行，含 `summary`/`leafUuid`）、`system`（`subtype` 有
    `local_command`/`turn_duration`/`compact_boundary`/`api_error`…）、`attachment`、
    `file-history-snapshot`、`last-prompt`、`ai-title`、`pr-link`、`queue-operation`、`permission-mode`、`mode`。
- **时间戳**：`timestamp`，**ISO 8601 UTC 带 `Z`**，如 `2026-05-13T05:17:57.966Z`。
  注意 Python 3.10 的 `fromisoformat` 不认 `Z`，先替换成 `+00:00`。
  `~/.claude/history.jsonl` 的 `timestamp` 是**毫秒整数**。
- **会话 id**：`sessionId` 字段；主会话文件名就是 `<sessionId>.jsonl`（但文件名不保证一定是 UUID）。
  按 `uuid`/`parentUuid` 可还原线程树。
- **来源链接**：
  - <https://raw.githubusercontent.com/neilberkman/ccrider/main/research/schema.md>
  - <https://raw.githubusercontent.com/repowise-dev/skiplevel/refs/heads/main/docs/schema-notes.md>
  - <https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/b072d279110bdda2c6ac2525d0d24dc54d16148a/packages/shared-skills/skills/coding-agent-sessions/references/claude.md>
- **把握程度**：**已证实**。说明：Anthropic **未官方公开**该 JSONL 内部格式，但上述三个独立来源
  （各自基于真实文件逆向）在路径、信封字段、content block 类型、拆行去重这一关键怪癖上互相印证，
  且本机 `~/.claude` 存在但当前无 `projects/`（该版本未产生会话，不影响格式结论）。

---

## Gemini CLI

- **路径**：`~/.gemini/tmp/<project_hash>/chats/session-*.jsonl`
  - `<project_hash>` 由项目根目录派生（官方源码 `getProjectHash(config.getProjectRoot())`）。
  - 辅助文件：`~/.gemini/logs.json`（轻量消息索引）、`~/.gemini/projects.json`（路径→project 桶映射）、
    `~/.gemini/state.json`（UI 状态，无用）。
  - 目录名是 hash，**无法反解**；用文件头里的 `projectHash` + `directories` 或 `projects.json` 映射。
- **形态**：JSONL。**注意版本差异**：新版写 `session-*.jsonl`；旧版是单个 JSON 文档 `session-*.json`
  （源码里仍保留 `.json` → `.jsonl` 的迁移分支）。
- **正文位置**：
  - 用户：`type=="user"` 的 `content[].text`
  - 助手：`type=="gemini"` 的 `content`（**字符串**）+ `thoughts[]`
- **消息结构（用户/助手）**：
  - 会话头（首行）：`{"sessionId":"...","projectHash":"...","startTime":"...","lastUpdated":"...","kind":"main"|"subagent"}`
  - 用户：`{"id":"<msg-id>","timestamp":"2026-05-03T15:01:31.511Z","type":"user","content":[{"text":"<提示词>"}]}`
  - 助手：`{"id":"<msg-id>","timestamp":"...","type":"gemini","content":"","thoughts":[],
    "tokens":{"input":11410,"output":105,"cached":0,"thoughts":65,"tool":0,"total":11580},
    "model":"gemini-3-flash-preview"}`；后续行可能带 `toolCalls[]`
    （`{id,name,args,result,status,timestamp,resultDisplay,description,displayName,renderOutputAsMarkdown}`）。
  - 控制行（非消息）：
    - `{"$set":{"lastUpdated":"..."}}` 元数据增量（也有 `$set` 带 `messages` 的整表替换）
    - `{"$patch":{...}}` 消息补丁（`updates`/`removeIds`/`orderIds`）
    - `{"$rewindTo":"<msg-id>"}` 回退标记（回退点及之后的消息作废）
  - **只取文本**：`type=="gemini"` 的 `content` 为字符串；`thoughts[]` 是思考，另存不要混进正文。
  - **必须去重**：助手轮次会被重写，同一 `id` 出现多行。**按 `id` 保留最后一行**。
    实测样本 17 个唯一助手 id / 32 行 `type=="gemini"`。
  - **空 content 不等于空轮次**：中间行常见 `content:""` 但仍带 `thoughts`/`toolCalls`/`tokens`。
- **时间戳**：`timestamp` 与 `startTime`/`lastUpdated` 均为 **ISO 8601 带 `Z`**。
- **会话 id**：`sessionId`（在会话头行）；文件名里也带一个短 id。
- **来源链接**：
  - <https://geminicli.com/docs/cli/session-management/>（官方文档：`~/.gemini/tmp/<project_hash>/chats/`）
  - <https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/services/chatRecordingService.ts>
    （官方源码：`getProjectHash`、`getProjectTempDir()/chats`、`$set`/`$patch`/`$rewindTo` 记录形态）
  - <https://raw.githubusercontent.com/rajbos/ai-engineering-fluency/refs/heads/main/docs/logFilesSchema/gemini-cli-session-format.md>
    （第三方真实样本实测，含各字段样例与去重统计）
- **把握程度**：**已证实**（路径来自官方文档，记录类型与 `$set`/`$patch`/`$rewindTo` 来自官方源码，
  字段级样例来自第三方实测）。
- **⚠️ 生命周期提示**：该官方文档页顶部声明 **Gemini CLI 已于 2026-06-18 被 Antigravity CLI 取代**
  （Unpaid 与 Google One 用户）。新增数据源前请确认目标用户当前装的是哪个。

---

## Qwen Code / 通义千问 CLI

- **路径**：`~/.qwen/tmp/<project_hash>/chats/`（与 Gemini CLI 同构，Qwen Code 是其 fork）
  - 该结论的**路径部分为推测**：依据是 Qwen Code 复用 Google 的 `chatRecordingService` 骨架
    （`this.context.config.storage.getProjectTempDir()` + `'chats'`），且 Qwen Code 仓库 issue
    `#11762` 的标题直接证实 `~/.qwen/tmp/<hash>/` 目录真实存在（其内至少含 `logs.json`）。
  - **部署前请在某台装了 Qwen Code 的机器上 `ls ~/.qwen/tmp/*/chats/` 实测一次。**
- **形态**：JSONL，每行一条 `ChatRecord`。
- **正文位置**：`ChatRecord.message`（Google GenAI `Content`：`{role, parts:[...]}`）
  - 用户：`type=="user"` 的 `message.parts[].text`
  - 助手：`type=="assistant"` 的 `message.parts[].text`（`parts[]` 里的 `thought` 部分是思考）
- **消息结构（用户/助手）**——以下字段名取自官方源码 `ChatRecord` 接口，**已证实**：
  ```
  uuid         string   逻辑消息唯一 id
  parentUuid   string|null   形成树，可回溯分支
  sessionId    string   会话 id
  timestamp    string   ISO 8601
  type         'user' | 'assistant' | 'tool_result' | 'system'
  message      Content  {role, parts:[{text} | {functionCall} | {functionResponse} | {thought}]}
  cwd          string   记录时的真实工作目录
  version      string   CLI 版本
  gitBranch    string?
  model        string?  仅助手
  usageMetadata object? 仅助手（GenAI usage）
  contextWindowSize number?
  subtype      string?  系统记录细分，如 'chat_compression','custom_title','session_model',
                        'notification','cron','mid_turn_user_message','goal_state',
                        'branch_checkpoint','file_history_snapshot','agent_mention','agent_message'…
  provenance   'real_user' | 'assistant_output' | 'tool_result' | 'execution_output' |
               'goal_control' | 'goal_runtime' | 'system' | 'external_agent'
  systemPayload object? 系统记录的业务载荷（如 notification 的 displayText）
  isSidechain  bool?    子 agent 流量
  ```
- **只取文本**：`message.parts[]` 中只取含 `text` 的 part；丢掉 `functionCall` / `functionResponse` / `thought`。
- **过滤注入**（重要，字段名与 Claude Code 不同，别混用）：
  - `provenance` 不是 `real_user` 的一律排除；
  - `subtype` 存在的一律排除（`cron` / `notification` / `mid_turn_user_message` / `goal_*` / `agent_*` 等都不是真人输入）；
  - `isSidechain==true` 排除。
- **⚠️ 不要和 Gemini CLI 共用一个分支**：Gemini CLI 的助手记录 `type` 是 **`"gemini"`**，
  Qwen Code 源码里是 **`"assistant"`**。同一个 fork 家族，取值不同。
- **时间戳**：`timestamp`，**ISO 8601**（源码 `new Date().toISOString()`，带 `Z`）。
- **会话 id**：`sessionId`；文件名为 `<sessionId>.jsonl`（PR #3190 记录「Session ID source = 文件名去掉扩展名」）。
- **来源链接**：
  - <https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/services/chatRecordingService.ts>
    （官方源码：`ChatRecord` 接口、`type`/`subtype`/`provenance` 全量取值、ISO 时间戳）
  - <https://github.com/QwenLM/qwen-code/issues/11762>（`~/.qwen/tmp/<hash>/` 实测存在）
  - <https://github.com/QwenLM/qwen-code/pull/3190>（会话 id 取自文件名）
  - <https://qwenlm.github.io/qwen-code-docs/en/users/conversations-recovery/>（官方文档站）
- **把握程度**：记录字段 **已证实**（官方源码）；**目录/文件名 推测**（fork 同构 + issue 旁证），
  必须先实测再上线。

---

## 豆包 / Doubao

**结论：不存在名为「Doubao CLI」的官方命令行编码 agent，因此也没有可采集的本地对话文件。**

- **豆包（Doubao）** 是字节跳动的消费级云端助手产品，会话在服务端，**本地不落对话记录**。
- 字节真正的官方命令行 AI agent 是 **veCLI**（火山引擎，2025-09-12 发布，npm 包 `@volcengine/vecli`，
  仓库 `github.com/volcengine/vecli`）。它访问豆包大模型（Doubao Seed 1.6），同时支持
  DeepSeek V3.1、Kimi-K2；配置走 `settings.json`（可配飞书 MCP）。
- **veCLI 的本地会话存储路径：未找到公开信息。** 官方仓库、npm 元数据、火山方舟文档均未公布
  会话/历史文件的落盘位置。npm 上该包多个版本被标记 `"deprecated": "Package no longer supported"`
  （最新 `0.1.31`），生命周期状态本身也需要先确认。
- 另有一个**非官方**终端客户端 `ChHsiching/doubao-cli`（用你本机 Chromium 会话驱动豆包 Web）。
  它不是 agent、也不产生自己的本地对话记录，**不可作为数据源**。
- 检索过的关键词：`豆包 CLI`、`Doubao CLI`、`豆包 命令行 coding agent`、`字节跳动 命令行 AI agent`、
  `Doubao terminal client`、`veCLI 会话 存储`、`@volcengine/vecli session history`、
  `vecli config directory`、`Doubao MCP`。
- **来源链接**：
  - <https://m.ithome.com/html/0882544.htm>（veCLI 发布，官方定位与模型支持）
  - <https://registry.npmjs.org/@volcengine/vecli>（包元数据 / 版本 / deprecated 标记）
- **把握程度**：
  - 「不存在 Doubao CLI、豆包无本地会话」= **已证实**（检索不到任何官方说法，且产品形态为云端）。
  - 「veCLI 的本地存储路径」= **未找到权威来源，未知**。请勿凭猜测写解析代码。
- **相关但不同**：本机装有字节的 IDE 产品 `Trae CN.app` / `TRAE SOLO CN.app`（VS Code fork，
  MarsCode/豆包同门），其 `~/Library/Application Support/Trae CN/User/workspaceStorage/<hash>/state.vscdb`
  是 VS Code 系布局。它是 **IDE 不是 CLI**，超出本文范围，需要单独调研。

---

## DeepSeek CLI（官方：DeepSeek Harness，`dsh`）

**先澄清命名**：DeepSeek 官方命令行 agent 叫 **DeepSeek Harness**，命令是 **`dsh`**（不是 `deepseek`）。
GitHub 上有若干同名第三方 wrapper（`holasoymalva/deepseek-cli`、`PierrunoYT/deepseek-cli`、
`@kavieno/deepseek-cli` 等），**不是官方**，不要混为一谈。
另外 Debian/Ubuntu 里早就有一个无关的 `dsh`（dancer's shell，分布式 shell），
所以「PATH 里有 dsh」**不能**作为安装证据。

- **路径**：
  - 数据根 `$DSH_HOME`，默认 `~/.dsh`。
  - 会话：`~/.dsh/sessions/<slug>/<session-id>/session[.vN].jsonl.zstd`
    - 本机实测**同时存在** `session.v3.jsonl.zstd` 和 `session.v4.jsonl.zstd`（同一会话目录内），
      也有只有 `session.v3.jsonl.zstd` 的旧会话。
    - 因此**解析器必须 glob `session*.jsonl.zstd`**，不要硬编码 `session.jsonl.zstd`
      （第三方文档写的是无版本后缀的那个名字，属旧版命名）。
  - 工作区索引：`~/.dsh/storages/workspace.json`（workspace 路径 → 有序 sessionIds）
  - 其他：`~/.dsh/storages/session_projcache/`、`~/.dsh/storages/workspace.json`、
    `~/.dsh/.credentials.yaml`（**密钥，别读**）。
  - 会话目录名（`<slug>`）与 Claude Code 同风格（`/` 等字符被替换成 `-`，包在 `--...--` 里），
    例如 `/Users/mikefox/work/code/mzlc` → `--Users-mikefox-work-code-mzlc--`。
    **不要反解**：解压后第一个 `type=="session"` 事件里有 `cwd`。
- **形态**：**zstd 压缩**，解压后是 **JSONL**，一行一个 JSON 事件。
- **正文位置字段路径**（`data` 为事件体）：
  - 用户：`type=="user/message"` → `data.content[]` 中 `type=="text"` 的 `text`
  - 助手：`type=="assistant/message"` → `data.message.content[]` 中 `type=="text"` 的 `text`
  - **只取文本**：助手 `content[]` 里还有 `{"type":"reasoning"}`（思考）与
    `{"type":"tool-call"}`（`name`/`arguments`/`id`）。只要 `type=="text"`。
- **消息结构（用户/助手）**：
  - 事件信封：`{"type":"<kind>","seq":<int>,"time":<ms>,"data":{...}}`（部分事件无 `seq`/`time`）。
  - 会话头（首行）：`{"type":"session","version":4,"id":"session-<uuid>","createdAt":<ms>,
    "cwd":"/Users/...","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}`
  - 用户：`{"type":"user/message","seq":10,"time":1789...,"data":{"content":[{"type":"text","text":"..."}],
    "source":{"kind":"..."}}}`
    - **`data.source.kind` 是过滤注入的关键**：运行时上下文/系统提醒这些也会写成 `user/message`
      （例如 `kind:"runtime-context"`、skill 目录提醒）。真人输入那次**不带** `source`（或不是这些 kind），
      上线前请先用真实数据确认该判定。
  - 助手：`{"type":"assistant/message","time":...,"data":{"turn":1,"step":1,
    "message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"reasoning",...},
    {"type":"tool-call",...}],"source":{"kind":"model","provider":"...","model":"..."}}}}`
  - 一个会话里能见到的 `type` 值（本机实测，v3/v4 各一份）：
    `session`, `user/message`, `assistant/message`, `system/message`, `tool/call`, `tool/result`,
    `step/start`, `step/end`, `turn/start`, `turn/end`, `session/title`, `session/title-llm-request`,
    `session/end-seed`, `deliverables/presented`, `compaction/prune`, `agent/inbox/spliced`,
    `request/header`, `request/context`, `permission/preset`, `sandbox/mode`, `approval/policy`,
    `approval/asked`, `approval/decided`, `model/selection`, `assistant/attempt`, `todo/write`,
    `llm/retry-started`, `subagent/model-selection-policy`, `subagent/descriptor`,
    `subagent/catalog`, `web/deepseek-search-llm-request`
    - **v3 有 `turn/end`，v4 事件集合更大**；同一 instrument 按 `type` 白名单取用即可，别按 v3 全集假设。
- **时间戳**：绝大多数事件是 `time`，**毫秒 epoch 整数**。会话头用 `createdAt`，同为毫秒。
  少数事件（如 `session`）没有 `time`。
- **会话 id**：会话目录名（`session-<uuid>` 或裸 uuid）+ `session` 事件的 `id` 字段。
- **来源链接**：
  - <https://github.com/deepseek-ai/deepseek-harness>（官方仓库，MIT，"Everything is a Plugin."）
  - <https://raw.githubusercontent.com/asheshgoplani/agent-deck/main/docs/tools/deepseek.md>
    （第三方实测文档：`$DSH_HOME`、`sessions/<slug>/<session-id>/session.jsonl.zstd`、
    `storages/workspace.json`、`@deepseek-ai/dsh`、官方/第三方命名辨析）
  - <https://apifox.com/apiskills/deepseek-harness-complete-guide/>（中文介绍）
- **把握程度**：**已证实**。路径与文件名后缀以**本机实测为准**（与第三方文档的差异已在上面写明）；
  事件类型集合、字段路径、时间戳单位均为本机解压实测。
  **⚠️ 上线前请确认版本**：本机看到 v3/v4 两代并存，`session` 事件里有 `version` 字段可用于分流。

---

## Kimi CLI / Kimi Code

Kimi 有**两代** CLI，路径和文件名都不一样，别混。

### A. Kimi Code CLI（当前版，`~/.kimi-code/`）

- **路径**：`$KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/`
  - 默认 `KIMI_CODE_HOME=~/.kimi-code`（可用环境变量整体搬走）。
  - 目录结构：
    ```
    ~/.kimi-code/
    ├── session_index.jsonl            # 会话索引（每行含 sessionId / sessionDir / workDir）
    ├── sessions/<workDirKey>/<sessionId>/
    │   ├── state.json                 # 会话元数据：title、lastPrompt、创建/更新时间、forkedFrom
    │   ├── upcoming-goals.json
    │   ├── agents/main/wire.jsonl     # ★ 主 agent 完整通信记录（正文在这里）
    │   ├── agents/<subagentId>/wire.jsonl
    │   ├── agents/main/plans/<id>.md
    │   ├── logs/kimi-code.log
    │   ├── tasks/<task_id>.json + tasks/<task_id>/output.log
    │   └── cron/
    └── user-history/<md5(workDir)>.jsonl   # 终端输入历史（只有用户输入，无回复）
    ```
  - `workDirKey` 形如 `wd_<slug>_<sha256前12位>`（官方文档明确给出格式）。
- **形态**：JSONL。
- **正文位置**：
  - 用户：`message.type=="TurnBegin"` → `message.payload.user_input`（字符串，或 ContentPart 数组）
  - 助手：`message.type=="ContentPart"` 且 `message.payload.type=="text"` → `message.payload.text`
- **消息结构（用户/助手）**——来自官方源码 `WireFile` / `WireMessageRecord` / `WireMessageEnvelope`：
  ```jsonl
  {"type":"metadata","protocol_version":"1.x"}                       <- 固定第一行
  {"timestamp": 1759123456.789,
   "message": {"type":"TurnBegin","payload":{"user_input":"你好"}}}
  {"timestamp": 1759123457.1,
   "message": {"type":"ContentPart","payload":{"type":"text","text":"..."}}}
  ```
  - 每行 = `{"timestamp": float, "message": {"type": <WireMessage 类型名>, "payload": {...}}}`
  - 消息类型名（`payload` 形状随之变化）：`TurnBegin`(`user_input`)、`SteerInput`(`user_input`)、
    `TurnEnd`、`StepBegin`(`n`)、`StepInterrupted`、`CompactionBegin`/`CompactionEnd`、
    `MCPLoadingBegin`/`MCPLoadingEnd`、`StatusUpdate`、`Notification`、`ContentPart`
    （`TextPart`=`{"type":"text","text"}`、`ThinkPart`）、`ToolCall`、`ToolCallPart`、`ToolResult`、
    `ApprovalRequest`/`ApprovalResponse`、`ToolCallRequest`、`QuestionRequest`、`SubagentEvent`。
  - **只取文本**：只要 `ContentPart` 且 `payload.type=="text"`；`ThinkPart` 是思考，`ToolCall*`/`ToolResult` 是工具。
  - **只取真人输入**：`TurnBegin` 的 `user_input` 是用户轮次起点；`SteerInput` 是轮次中途注入，
    按需排除。`SubagentEvent` 内嵌子 agent 事件（子 agent 有自己的 `wire.jsonl`），排除可避免重复。
- **时间戳**：`timestamp`，**float，Unix 秒**（源码 `time.time()`）。`state.json` 另含 ISO/时间元数据。
- **会话 id**：目录名 `<sessionId>`；`session_index.jsonl` 里的 `sessionId`。
- **来源链接**：
  - <https://moonshotai.github.io/kimi-code/en/guides/sessions>（官方：会话存储结构、`session_index.jsonl`）
  - <https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html>
    （官方：完整目录布局、`workDirKey` 格式 `wd_<slug>_<sha256前12>`、`user-history/<md5(workDir)>.jsonl`）
  - <https://raw.githubusercontent.com/MoonshotAI/kimi-cli/8283d785/src/kimi_cli/wire/file.py>
    （官方源码：`WireMessageRecord` = `{timestamp, message}`、首行 metadata）
  - <https://raw.githubusercontent.com/MoonshotAI/kimi-cli/8283d785/src/kimi_cli/wire/types.py>
    （官方源码：全部 WireMessage 类型与 payload 字段）
- **把握程度**：**已证实**。

### B. 旧版 kimi-cli（`~/.kimi/`）

- **路径**：`$KIMI_SHARE_DIR`（默认 `~/.kimi`）下：
  - `~/.kimi/kimi.json`：元数据，含 `work_dirs[].path` / `last_session_id`
  - `~/.kimi/sessions/<md5(工作目录)>/<session_id>/`
    - `context.jsonl`：消息历史（每行有 `role`；以 `_` 开头的 `role` 表示内部记录）
    - `wire.jsonl`：同上文 A 的 wire 格式（同一套 `WireFile` 实现）
  - 迁移痕迹：旧版本曾把 `sessions/<session_id>.jsonl` 直接放在 sessions 根下，
    新版本会重命名为 `<session_id>/context.jsonl`。
- **时间戳 / 会话 id**：同 A（`wire.jsonl` 的 `timestamp` 秒；目录名即 session id）。
- **来源链接**：
  - <https://raw.githubusercontent.com/MoonshotAI/kimi-cli/8283d785/src/kimi_cli/share.py>
    （`KIMI_SHARE_DIR`，默认 `~/.kimi`）
  - <https://raw.githubusercontent.com/MoonshotAI/kimi-cli/8283d785/src/kimi_cli/metadata.py>
    （`sessions_dir = share_dir/sessions/<md5(path)>`）
  - <https://raw.githubusercontent.com/MoonshotAI/kimi-cli/8283d785/src/kimi_cli/session.py>
    （`context.jsonl` + `wire.jsonl`、旧路径迁移逻辑）
- **把握程度**：**已证实**（官方源码）。

---

## OpenCode

> 注意：仓库已迁移（现为 <https://github.com/anomalyco/opencode>），并已发布 v2。

- **路径（macOS/Linux）**：`~/.local/share/opencode/`（官方文档明确，尊重 `XDG_DATA_HOME`）
  - `auth.json`（认证数据，**别读**）
  - `log/`（应用日志，保留最近 10 个）
  - `project/`（**项目相关的会话与消息数据**）
    - 项目在 Git 仓库内：`project/<project-slug>/storage/`
    - 不在 Git 仓库内：`project/global/storage/`
- **形态**：官方文档只说「`project/` 下是 session 和 message 数据」，**没有列出文件级 schema**。
  第三方在真实安装上实测到的两代结构（**推测级**，需实测复核）：
  1. **SQLite（较新）**：`~/.local/share/opencode/opencode.db`
     - `session(id, project_id, parent_id, directory, title, time_created, ..., cost, tokens_input, tokens_output, ...)`
       —— `directory` 即 cwd；`parent_id` 非空表示子 agent 会话。
     - `message(id, session_id, time_created, data)` —— `data` 是该消息的 JSON
     - `part(id, message_id, session_id, time_created, data)`
     - WAL 模式，会有 `.db-shm`/`.db-wal`；**只读打开**（`mode=ro` + `PRAGMA query_only`）。
  2. **JSON 树（Pre-1.2）**：`storage/session/<projectID>/ses_*.json`、
     `storage/message/<sessionID>/msg_*.json`、`storage/part/<sessionID>/<messageID>/prt_*.json`
- **正文位置**（**关键**）：**正文不在 message 上，而在 `part` 里。**
  - `part.data.type`: `text` | `reasoning` | `tool` | `step-start` | `step-finish` | `patch`
  - 只取 `data.type=="text"` 的文本。
  - `message.data` 的 JSON：用户 `{"role":"user","time":{"created":<ms>},...}`；
    助手示例（实测）：
    ```json
    {"role":"assistant","mode":"build","agent":"build","path":{"cwd":"...","root":"..."},
     "cost":0,"tokens":{"total":4117,"input":4096,"output":21,"reasoning":0,
     "cache":{"write":0,"read":0}},
     "modelID":"qwen2.5-coder:7b","providerID":"ollama",
     "time":{"created":1780398431744,"completed":1780398480810},"finish":"stop"}
    ```
  - 工具 part：`{"type":"tool","tool":"read","callID":"call_...","state":{"status":"completed",
    "input":{"filePath":"..."},"output":"...","time":{"start":<ms>,"end":<ms>}}}`；
    `state.status` ∈ `pending|running|completed|error`；出错时 `state.error` 代替 `output`。
    工具结果挂在**助手的 part** 上（不是单独的用户消息）。
- **时间戳**：Unix **毫秒**（表列 `time_created` + JSON 内 `time.created`/`time.completed`）。
- **会话 id**：`session.id`（形如 `ses_...`）；`message.session_id`；`part.session_id`。
- **来源链接**：
  - <https://opencode.ai/docs/troubleshooting/>（官方：`~/.local/share/opencode/`、
    `project/<slug>/storage/`、`global/storage/`、`log/`、`auth.json`）
  - <https://raw.githubusercontent.com/repowise-dev/skiplevel/refs/heads/main/docs/schema-notes-opencode.md>
    （第三方对真实 `opencode.db` 的实测：三代存储、表/列名、message/part JSON 形状）
- **把握程度**：
  - 顶层目录与 `project/.../storage/` 布局：**已证实**（官方文档）。
  - `opencode.db` 的表名列名与 message/part JSON：**推测**（第三方实测，且**与官方文档描述的
    `project/<slug>/storage/` 布局不一致** —— 可能是版本/文档时差，也可能是 v2 改了布局）。
  - **上线前必须**：在目标机器上 `ls -R ~/.local/share/opencode | head -50` +
    `sqlite3 ~/.local/share/opencode/opencode.db ".tables"` 确认走哪一代。

---

## OpenClaw

- **路径**（官方文档 <https://docs.openclaw.ai/reference/session-management-compaction/store> 明确给出）：
  按 agent 隔离，在**运行 Gateway 的那台机器**上（远程模式下列本地看不到）：
  - 运行时会话行 + 转录行：`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
  - 归档转录文件：`~/.openclaw/agents/<agentId>/sessions/`
  - 旧版迁移输入：`~/.openclaw/agents/<agentId>/sessions/sessions.json`
  - 入口解析代码：`src/config/sessions.ts`
  - **注意**：`~/.openclaw/sessions/`（无 agentId 的旧路径）**已不再是隐式回退**。
- **形态**：**SQLite**，两层持久化：
  1. **会话行**（key/value 映射 `sessionKey -> SessionEntry`），可变运行时状态；
  2. **转录行**（append-only、**树结构**，条目有 `id` + `parentId`），存对话、工具调用、压缩摘要。
  两者默认在**同一个** `openclaw-agent.sqlite` 文件里。
- **正文位置**：转录条目里 `type=="message"` 的 user/assistant/toolResult 项。
  - 官方文档明确了转录**条目类型**，但**未公开 SQLite 表名与列名**：
    首个条目是会话头：`type:"session"`、`id`、`cwd`、`timestamp`、可选 `parentSession`；
    其余条目带 `id` + `parentId`（树）。条目类型：
    `message`、`custom_message`（进入模型上下文，`display:true/false` 控制是否可见）、
    `custom`（不进模型上下文）、`compaction`（含 `firstKeptEntryId`、`tokensBefore`）、
    `reset`（新历史窗口，可含 `firstKeptEntryId`）、`branch_summary`。
  - **历史窗口语义**：读取时以「最近一次 `reset` 窗口 + 其后的 `compaction`」为准；
    更早的消息与压缩摘要**不会**重新出现。取「AI 最终回复」时要按这个语义还原，别按全表时间序。
- **消息结构**：`SessionEntry` 的关键字段（官方文档列出，但这是**会话行**不是消息体）：
  `sessionId`、`sessionStartedAt`、`lastInteractionAt`、`updatedAt`、`archivedAt`、`pinnedAt`、
  `snoozedUntil`/`snoozedAt`、`lastReadAt`/`markedUnreadAt`、`lastActivityAt`、`sessionFile`、
  `chatType`(`direct|group|room`)、`label`、`autoLabel`、`displayName`、`subject`、`groupChannel`、`space`、
  `thinkingLevel`/`verboseLevel`/`reasoningLevel`/`elevatedLevel`/`sendPolicy`、
  `providerOverride`/`modelOverride`/`authProfileOverride`、
  `inputTokens`/`outputTokens`/`totalTokens`/`contextTokens`、`compactionCount`、
  `memoryFlushAt`/`memoryFlushCompactionCount`。
  消息体本身的字段名**官方未公开**（表结构也没给），需要实测。
- **时间戳**：官方在对比 Codex 时明确写道「OpenClaw timestamps are **epoch milliseconds** while
  Codex uses epoch seconds」。即 **毫秒**。
- **会话 id / key**：`sessionKey` 模式
  - 主/私聊：`agent:<agentId>:main`
  - 群：`agent:<agentId>:<channel>:group:<id>`
  - 房间/频道：`agent:<agentId>:<channel>:channel:<id>` 或 `...:room:<id>`
  - Cron：`cron:<job.id>`；Webhook：`hook:<uuid>`
  - `sessionKey` 指向当前 `sessionId`（即转录身份）。每日/空闲重置会换新 `sessionId`。
  - 另有保留前缀 `incognito-`（内部会话，**不落盘**，采集不到属正常）。
- **来源链接**：
  - <https://docs.openclaw.ai/concepts/session>（路径、「Where state lives」）
  - <https://docs.openclaw.ai/reference/session-management-compaction/store>（两层持久化 + 逐 agent 路径）
  - <https://docs.openclaw.ai/reference/session-management-compaction/schema>
    （sessionKey 模式、SessionEntry 字段、转录条目类型、历史窗口语义）
- **把握程度**：
  - 路径、形态（SQLite）、两层结构、条目类型、时间戳单位、sessionKey 模式：**已证实**（官方文档）。
  - **消息体的表名/列名：未找到权威来源。** 官方文档刻意没给 SQL schema，只给「条目类型」。
    上线前必须 `.schema` 实测。另外 Gateway 可能持续持有该 DB，**只读打开**、并注意 WAL。

---

## Paperclip

**结论：Paperclip 存在，但它是一个「管 agent 的自托管服务」，不是本地 CLI 会话文件的数据源。建议不做。**

- **它是什么**：<https://github.com/paperclipai/paperclip> —— 自述 "The open-source app everyone uses
  to manage agents at work"。官网 <https://paperclip.ing>，文档 <https://docs.paperclip.ing>。
  带控制台、Issue/Goal/Routine、审批、成本预算、CLI，是一个**服务端应用**，有自己的数据库
  （文档有独立的 "Database Configuration" 与 "Back up / Restore" 章节）。
- **它怎么产生「对话」**：通过 **adapter** 调用**别人家的 agent**。官方 adapter 列表（22 个）包含：
  Claude Code、Codex、Gemini CLI、Cursor Local、Cursor Cloud、OpenCode、Pi、Hermes、Hermes Gateway、
  Grok Local、Kimi Code、OpenClaw Gateway、Process、HTTP、Paperclip Runner、Sandbox Providers、Modal…
  —— 所以真正的会话记录落在**被委托的那个 CLI 的存储**里（例如 Claude Code 的
  `~/.claude/projects/...`），或者落在 Paperclip 自己的服务端数据库里。
- **不做的理由**：
  1. 它**没有** macOS 上的 CLI 会话文件；对话在服务端 DB，路径由部署方式/环境变量决定，
     不是固定的 `~/.xxx`，只读采集器无从稳定枚举。
  2. 即使采到，也是「服务端聚合视图」，与用户在本机终端里跟 Claude Code 直接对话的记录**重复**。
  3. 若确实需要 Paperclip 的数据，正确做法是走它的 API（文档有完整 REST/CLI 参考），
     而不是猜它的私有 DB。
- **来源链接**：
  - <https://github.com/paperclipai/paperclip>
  - <https://docs.paperclip.ing/reference/adapters/overview/>（adapter 总览）
  - <https://docs.paperclip.ing/guides/org/agent-adapters/>（选择 adapter）
  - <https://docs.paperclip.ing/reference/deploy/database/>（数据库配置）
  - <https://docs.paperclip.ing/how-to/back-up-and-restore-a-company/>
- **把握程度**：**已证实**（产品形态、adapter 清单、自托管 + 自带数据库）。
  其数据库的**具体表结构 / 本地路径：未找到**（依赖部署配置），因此也不作为数据源。

---

## Hermes Agent

- **路径**：`~/.hermes/state.db`
  - 官方强调**不要硬编码**：真实路径由 `get_hermes_home()` 解析 ——
    进程内 override → 环境变量 `HERMES_HOME` → 平台默认（macOS/Linux 为 `~/.hermes`；
    Windows 为 `%LOCALAPPDATA%/hermes`）。默认数据库永远是 `get_hermes_home() / "state.db"`。
  - **命名 profile 是隔离目录**：名为 `coder` 的 profile → `<默认根>/profiles/coder/state.db`
    （自己的 DB、配置、日志）。采集时**必须**遍历 `~/.hermes/profiles/*/state.db`，
    否则会漏掉非默认 profile 的全部历史。
- **形态**：**SQLite**（WAL 模式）。
- **正文位置**：
  - 用户：`messages` 表 `WHERE role='user'` → `content`
  - 助手：`messages` 表 `WHERE role='assistant'` → `content`
- **消息结构（用户/助手）**——`messages` 表（官方文档给的是 abridged 版，完整版还含
  `effect_disposition`、`platform_message_id`、`observed`、`active`、`compacted`、`api_content`、
  `display_kind`、`display_metadata`、`message_uid`、`absorbed_message_uids`、
  `tool_call_uids`、`tool_call_uid`）：
  ```sql
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,                 -- 'user' | 'assistant' | 'tool' ...
    content TEXT,                       -- ★ 正文
    tool_call_id TEXT,
    tool_calls TEXT,                    -- JSON 字符串：工具调用列表
    tool_name TEXT,
    timestamp REAL NOT NULL,            -- ★ Unix epoch 浮点（time.time()）
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,                     -- ★ 思考，不是正文
    reasoning_content TEXT,
    reasoning_details TEXT,             -- JSON 字符串
    codex_reasoning_items TEXT,
    codex_message_items TEXT
  );
  ```
  - **只取正文**：`content`。`reasoning`/`reasoning_content` 是思考，**不要**混入回复。
  - **⚠️ 必须过滤 `active=1`**：原地压缩会把旧行归档为 `active=0`、插入保留上下文为 `active=1`；
    一条受保护消息可能**同时**存在于两代（内容与时间戳完全相同），文档明确说
    **不要把归档行当重复删除**，诊断重复活写只看 `active=1`。
  - **`message_uid` 是稳定消息身份**（32 位 hex，`uuid4().hex`）：跨压缩代/轮转/克隆保持不变，
    而物理 `id` 会变。**按 `message_uid` 去重**比按 `id` 稳。
  - **边界情况**：纯推理干净停止时，`content` **保持为空**，文本在 `reasoning`/`reasoning_content`，
    `api_content` 里带同一份以便逐字节重放。所以「助手回复」要按 `content` 取，
    取到空时看是否属于这种推理型回复（官方明确：历史界面把它显示为 reasoning，不是回复）。
  - 最后一条 Responses 回复可能只存在于 `codex_message_items` 而 `content` 为空。
- **时间戳**：`timestamp`，**REAL，Unix epoch 浮点（秒）**。
- **会话 id**：`sessions.id`（如 `sess_abc123`）；谱系 `parent_session_id`。
  `sessions` 表另有 `source`（`cli`/`telegram`/`discord`/`desktop`/`subagent`…）、
  `started_at`/`ended_at`、`title`（非 NULL 时唯一）、`message_count`、
  `input_tokens`/`output_tokens`/`reasoning_tokens`、`cwd`/`git_branch`/`git_repo_root`、`archived`/`auto_archived`。
  其他表：`session_model_usage`、`messages_fts`（+ `_trigram`、`_cjk`）、`state_meta`、
  `gateway_routing`、`compression_locks`、`async_delegations`、`delivery_obligations`、`schema_version`
  （当前 schema 版本 31）。
  - **提示**：`messages_fts_trigram` 是 CJK/子串检索表，v29/v30 起会排除 cron 与 subagent 会话；
    要用全文检索时注意这点，但**取正文请查 `messages` 表本身**。
- **来源链接**：<https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage>
  （官方开发者文档：路径、profile 隔离、完整架构图、`sessions`/`messages` DDL、迁移历史、时间戳单位、
  `message_uid`、`active` 语义、推理型停止的边界情况）
  另有官方项目页 <https://github.com/NousResearch/hermes-agent>（MIT，Nous Research）。
- **把握程度**：**已证实**（官方开发者文档，字段名与语义都写明了）。
  仅「全部附加列」不完整（文档自称 abridged），列全量需 `.schema` 实测。

---

## Devin Desktop

**结论：技术上是 protobuf，且与 Windsurf 共用同一份存储、无法区分来源。对这个日报工具，建议不做。**

- **它是一个 Windsurf 的 fork/rebrand**（Cognition 收购 Windsurf 团队后生产）。官方 `product.json`
  内含 `"nameShort": "Devin"`、`"dataFolderName": ".devin"`、**`"oldDataFolderName": ".windsurf"`**；
  捆绑的 AI 扩展 id 仍是 `codeium.windsurf`。
- **路径**：`~/.codeium/windsurf/cascade/*.pb`（另有 `~/.codeium/windsurf/implicit/*.pb`）
  - **没有 Devin 专属会话目录。** Devin 自己的 `~/.devin` 是标准 VS Code 系布局
    （`User/workspaceStorage/<hash>/state.vscdb`、`User/globalStorage/state.vscdb` 等），
    但在真实安装上 `chat.ChatSessionStore.index`、`agentSessions.model.cache`、
    `agentSessions.state.cache` **全是空的** —— 会话数据不在那里。
  - **未知来源**：`.pb` 文件本身**不携带**「这是 Devin 产生的还是 Windsurf 产生的」信号。
    只有在扩展运行时通过 `vscode.env.appName` 才能标注；纯文件扫描会把 Devin 的会话
    一律标成 Windsurf（已知限制）。
- **形态**：**protobuf（`.pb`）**，不是 JSON/JSONL/SQLite。
- **正文位置**：未公开；需自行逆向 protobuf schema。第三方也未能给出字段路径。
- **时间戳 / 会话 id**：未公开（trajectory id 可从虚拟路径 `devin://trajectory/{id}` / 文件名取）。
- **另一个不同工具：Devin CLI**（ACP 协议、Rust 实现，内部代号 "chisel"，与桌面版无关）
  - **路径**：macOS `~/Library/Application Support/devin/cli/sessions.db`
    —— **未在 macOS 上实测，属推测**（按 Rust `dirs` crate 约定推断）。Windows 已实测
    `%APPDATA%\devin\cli\sessions.db`。
  - 形态：SQLite（单一全局库，无 per-project 注册表）。
  - 表：`sessions`（`id`、`working_directory`、`backend_type`、`model`、`agent_mode`、
    `created_at`、`last_activity_at`、`title`、`main_chain_id`、`shell_last_seen_index`、
    `cogs_json`、`workspace_dirs`、`hidden`、`metadata`）；
    `message_nodes`（**树**：`row_id`、`session_id`、`node_id`、`parent_node_id`、`chat_message`、`created_at`、`metadata`）；
    `prompt_history`（`id`、`content`、`timestamp`、`session_id`、`is_shell`）；
    `tool_call_state`（`session_id`、`tool_call_id`、`tool_call_json`、`tool_call_update_json`）。
  - **正文**：`message_nodes.chat_message`（JSON）—— **形状未证实**，第三方只能按 ACP v2 schema 猜测
    （`{role, content}` / `{sessionUpdate, content}` / 扁平 `{text}`）。构建时**所有表都是 0 行**，
    一个真实样例都没拿到。
  - **分支还原**：消息是树，`sessions.main_chain_id` 指向当前活动分支叶子，需沿 `parent_node_id`
    往回走到根；`main_chain_id` 缺失时退化为按 `created_at` 排序。
  - **时间戳**：`created_at`/`last_activity_at` 是 epoch 整数，但**秒还是毫秒未证实**。
- **来源链接**：
  - <https://raw.githubusercontent.com/rajbos/ai-engineering-fluency/refs/heads/main/docs/logFilesSchema/devin-windsurf-session-format.md>
    （桌面版：product.json 证据、Cascade `.pb` 共用、`~/.devin` 无会话数据）
  - <https://raw.githubusercontent.com/rajbos/ai-engineering-fluency/refs/heads/main/docs/logFilesSchema/devin-cli-session-format.md>
    （CLI：路径、表结构、未证实项清单）
  - <https://docs.devin.ai/zh/desktop/devin-local>（官方 Devin Local Agent 说明）
- **把握程度**：
  - 桌面版「会话在共用 Cascade protobuf、`.devin` 下没有会话数据」= **已证实**（第三方在真实安装上验证）。
  - Devin CLI 的 macOS 路径 = **推测**（Rust `dirs` 约定，未实测）。
  - Devin CLI 的 `chat_message` JSON 形状、时间戳单位 = **未找到权威来源，属推测**。
- **不建议做的理由**：桌面版是 protobuf + 来源不可辨；CLI 是空库 + 形状全猜。
  两个方向的采集代码都只能靠猜，属于「下游代码全是错的」的高风险类型。

---

## WorkBuddy

- **它是什么**：腾讯的企业级办公 AI agent 桌面工作台。腾讯云产品矩阵里，
  **CodeBuddy** = AI 原生编程工具（插件 / IDE / CLI 三形态），
  **WorkBuddy** = 全场景职场 AI 智能体桌面工作台，
  **WorkBuddy Managed Agents (WMA)** = 云端托管智能体运行服务，基于 **WorkBuddy Harness 内核**。
  本机安装的是 `WorkBuddy AI.app`（bundle id `com.workbuddy.workbuddy-ai`），会话文件里带
  `__codebuddyLocal` 标记 —— 与上面的产品谱系一致。
- **路径**（本机实测）：
  - 数据根：`~/.workbuddy-ai/`
  - **对话正文**：`~/.workbuddy-ai/projects/<编码后cwd>/<session-uuid>.jsonl`
    - 同级还有 `<session-uuid>.meta.json`、`<session-uuid>.file-rollback.ndjson`、
      `<session-uuid>/tool-results/`
    - 目录名编码：`/Users/mikefox/work/code/mzlc/linmo-desktop` →
      `Users-mikefox-work-code-mzlc-linmo-desktop`（**注意：没有前导 `-`**，与 Claude Code 不同）。
      **不要反解**，读行内 `cwd`。
  - **会话索引 DB**：`~/.workbuddy-ai/workbuddy.db`（SQLite）
    - 本机有表：`sessions`、`workspaces`、`automations`、`automation_runs`、`automation_runtime_state`、
      `automation_delivery_outbox`、`session_usage`、`buddy_snapshots`、`migration_meta`
    - **没有 messages 表** → 正文只在 JSONL 里，DB 只是元数据索引。
    - `sessions` 列（来自 DB 内自带的迁移 DDL `~/.workbuddy-ai/.workbuddy-sqlite-migrations/0000_workbuddy_sqlite_baseline.sql`）：
      `id`(PK)、`cwd`、`user_id`、`title`、`custom_title`、`status`、`created_at`、`updated_at`、
      `last_activity_at`、`deleted_at`、`is_playground`、`source_mode`、`is_background_automation`、
      `mode`、`model`、`expert_id`、`expert_locale`、`expert_runtime_identity`、`expert_marketplace`、
      `permission_mode`、`use_sandbox_cli`、`project_id`（后续迁移追加：`plugin_context_json`、
      `addon_selection`、`session_settings`、`last_user_prompt_expert_selection`、`context_window`、
      `buddy_snapshot_id`、`buddy_binding_json`、`thought_level`）
  - 其他相关目录：`~/.workbuddy-ai/traces/<pid>/trace_*.json`（**只含 span 追踪**：
    `trace` / `spans[]`，发现过 `generation`、`terminalTitleGenerator`；**不是对话正文**）；
    `~/.workbuddy/logs/`（日志）；`~/.workbuddy-ai/sessions/`（本机为空）。
- **形态**：JSONL（一行一事件）+ SQLite（元数据索引）。
- **正文位置**：
  - 用户：`type=="message"` 且 `role=="user"` → `content[]` 中 `type=="input_text"` 的 `text`
  - 助手：`type=="message"` 且 `role=="assistant"` → `content[]` 中 `type=="output_text"` 的 `text`
- **消息结构（用户/助手）**（本机实测字段名）：
  ```json
  {"type":"message","id":"<uuid>","parentId":"<uuid|null>","sessionId":"<uuid>",
   "cwd":"/Users/...","timestamp":1790078870320,"role":"user",
   "content":[{"type":"input_text","text":"..."}],
   "providerData":{"agent":...,"model":...,"messageId":...,"traceId":...,"usage":{...}},
   "__codebuddyLocal":{...}}
  ```
  - 助手同形，`role:"assistant"`，`content[].type` 为 **`output_text`**（注意：**不是** `text`，
    这是 OpenAI Responses 风格的命名）。
  - 有的记录还带顶层 `status`、`message` 键（健康/流式态的变体）。
  - 其他 `type` 值（本机实测）：
    - `reasoning`：`{type, id, parentId, sessionId, cwd, timestamp, content[], rawContent[], providerData}`
      —— 思考，另存不要混入正文。
    - `function_call`：`{type, id, parentId, sessionId, cwd, timestamp, callId, name, arguments, message?}`
    - `function_call_result`：工具结果
    - `file-history-snapshot`：`{type, id, cwd, timestamp, isSnapshotUpdate, snapshot}`
    - `ai-title`：`{type, id, sessionId, cwd, timestamp, aiTitle}` —— 会话标题（可直接用作日报标题）
- **时间戳**：`timestamp`，**毫秒 epoch 整数**（如 `1790078870320`）。
  DB 的 `created_at`/`updated_at`/`last_activity_at` 同为整数毫秒。
- **会话 id**：`sessionId` 字段；文件名 `<session-uuid>.jsonl`；DB `sessions.id` 与之对应。
- **来源链接**：
  - 产品与归属（官方）：<https://cloud.tencent.cn/document/product/1831/134407>
    （WorkBuddy Enterprise 产品矩阵：CodeBuddy / WorkBuddy / WMA，WorkBuddy Harness 内核）
  - 路径与字段：**本机 `~/.workbuddy-ai/` 实测**，schema 依据为应用自带的迁移 DDL
    `~/.workbuddy-ai/.workbuddy-sqlite-migrations/0000_workbuddy_sqlite_baseline.sql`
  - 公开的**格式**文档：未找到（腾讯云文档只到产品层面）。
- **把握程度**：**已证实**（本机实测：真实目录、真实字段名、真实行类型统计、应用自带 DDL）。
  公开文档只覆盖产品定位，不覆盖文件格式 —— 因此**字段名以本机实测为准**，
  但要留意这是**未公开格式**，随版本变更无公告，建议采集端做防御性解析。

---

## 实测复核：题目给出的两条「已知事实」

### 1. Codex CLI —— **与公开信息一致，并补充了字段细节**

- ✅ `~/.codex/thread_history*.sqlite` 存在（本机 `thread_history_1.sqlite`，6.3 MB）。
- ✅ 表 `thread_items`，列 **`thread_id` / `turn_id` / `item_id` / `rollout_ordinal` / `created_at_ms` /
  `item_json` / `item_type` / `updated_at_ordinal` / `started_at_ms` / `completed_at_ms`**，
  主键 `(thread_id, turn_id, item_id)`。题目给的 `thread_id/turn_id/created_at_ms/item_json/item_type`
  全部命中。
- ✅ `item_type` 实测取值：`userMessage`、`agentMessage`、`reasoning`、`commandExecution`、
  `fileChange`、`mcpToolCall`、`imageView`、`sleep`、`contextCompaction`、`subAgentActivity`、
  `collabAgentToolCall`。
- ✅ 同库还有 `thread_turns`（`thread_id`、`turn_id`、`rollout_ordinal`、`status`、`error_json`、
  `started_at`、`completed_at`、`duration_ms`、`first_user_item_id`、`final_agent_item_id`、
  `rollout_byte_offset`…）、`thread_history_projection_state`、`thread_realtime_items`。
- ✅ **官方源码佐证**：`codex-rs/state/thread_history_migrations/0001_thread_history.sql`
  定义了 `thread_history_1.sqlite` / `thread_turns` / `thread_items` /
  `thread_history_projection_state`；该 migration 的原始列**只有**
  `thread_id, turn_id, item_id, rollout_ordinal, item_json` ——
  题目给的 `item_type` 与 `created_at_ms` 是**后续版本追加**的（本机正是较新版本）。
  另有 `THREAD_HISTORY_DB_FILENAME = "thread_history_1.sqlite"`。
- ✅ `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间>-<uuid>.jsonl` 存在，每行
  `{"timestamp":"<ISO>","type":"<kind>","payload":{...}}`；`type` 实测有 `session_meta`、
  `turn_context`、`response_item`、`event_msg`、`world_state`、`token_usage_record`。
  消息在 `response_item` 且 `payload.type=="message"`，`payload.role` ∈ `developer|user|assistant`，
  内容块 `payload.content[].type` ∈ `input_text|output_text`（**不是 `text`**）。
- ⚠️ 题目说的 `~/.codex/archived_sessions/*.jsonl` 本机**不存在** —— 因为本机没有归档过线程。
  第三方文档确认归档后会出现在 `~/.codex/archived_sessions/`（同 `sessions/` 的目录布局），
  且 `state_<N>.sqlite` 的 `threads` 表有 `rollout_path` 指向对应 rollout 文件。
  → 结论：**描述正确，只是本机无归档数据**。
- **`item_json` 字段名（本机实测，采集直接可用）**：
  - `userMessage` → `["clientId","content","id","type"]`
  - `agentMessage` → `["delivery","id","memoryCitation","phase","questions","text"]`（**正文是 `text`**）
  - `reasoning` → `["content","id","summary","type"]`
- **来源链接**：
  - <https://github.com/openai/codex/commit/414217dc8accc5c0e2542239cbab6eaa815dc605>
    （官方 commit + `.patch`：db 文件名与 migration DDL）
  - <https://raw.githubusercontent.com/rajbos/ai-engineering-fluency/refs/heads/main/docs/logFilesSchema/codex-cli-session-format.md>
    （第三方：`sessions/`、`archived_sessions/`、`state_<N>.sqlite` 的 `threads` 表、rollout JSONL 字段）
- **把握程度**：**已证实**（本机 SQLite schema + 官方 migration 源码 + 第三方文档三方一致）。

### 2. DeepSeek Harness（DSH）—— **与公开信息一致，但文件名带版本后缀**

- ✅ `~/.dsh/sessions/**/*.zstd` 成立。
- ✅ zstd 解压后是 **JSONL**，事件 `type` 形如 `user/message`、`assistant/message`、
  **`deliverables/presented`（确实存在，本机实测 14 条）**。
- ⚠️ **需要修正的细节**：文件名**不一定**是 `session.jsonl.zstd`。本机实测同一会话目录下
  可同时存在 **`session.v3.jsonl.zstd` 和 `session.v4.jsonl.zstd`**，旧会话只有 v3。
  → **解析器请 glob `session*.jsonl.zstd`**，并用 `session` 事件的 `version` 字段分流。
- ✅ 事件信封 `{"type","seq","time","data"}`；`time` 为**毫秒 epoch**。
- ✅ v3 与 v4 事件集合不同（v4 明显更多，如 `compaction/prune`、`approval/asked`、
  `assistant/attempt`、`todo/write`、`model/selection`、`llm/retry-started`、`subagent/catalog`）。
- ✅ 公开信息：官方仓库 <https://github.com/deepseek-ai/deepseek-harness>（MIT，自述
  "Everything is a Plugin."）；`@deepseek-ai/dsh`；`$DSH_HOME` 默认 `~/.dsh`；
  `storages/workspace.json` 记录 workspace → 有序 sessionIds。
- **来源链接**：
  - <https://github.com/deepseek-ai/deepseek-harness>
  - <https://raw.githubusercontent.com/asheshgoplani/agent-deck/main/docs/tools/deepseek.md>
- **把握程度**：**已证实**（本机解压实测 + 官方仓库 + 第三方文档；差异点已明确标注）。

---

## 查不到 / 不建议做的

### A. 明确「查不到」的

| 对象 | 状态 | 说明 |
|---|---|---|
| **豆包 / Doubao CLI** | **未找到该工具的公开信息** | 不存在官方「Doubao CLI」；豆包是云端消费级助手，无本地会话文件。字节的官方命令行 agent 是 **veCLI**（`@volcengine/vecli`）。<br>检索词：`豆包 CLI`、`Doubao CLI`、`豆包 命令行 coding agent`、`字节跳动 命令行 AI agent`、`Doubao terminal client`、`Doubao MCP`、`豆包 本地 对话记录` |
| **veCLI 本地会话存储** | **未找到权威来源** | veCLI 真实存在（2025-09-12 发布，火山引擎），但官方仓库 / npm 元数据 / 火山方舟文档**均未公布**会话落盘路径与格式。不得凭空推测。<br>检索词：`veCLI 会话 存储`、`veCLI history`、`@volcengine/vecli session history`、`vecli config directory`、`vecli settings.json`、`veCLI 历史记录` |
| **OpenClaw 消息体的表名/列名** | **未找到权威来源** | 官方文档给了路径、形态（SQLite）、两层结构、转录**条目类型**与 sessionKey 模式，但**刻意没给 SQL schema**。需 `.schema` 实测后才能写解析代码。 |
| **Paperclip 自有数据库的表结构/本地路径** | **未找到** | 属部署配置决定（官方有 Database Configuration 章节），非固定 `~/.xxx`。 |
| **Devin CLI 的 `chat_message` JSON 形状、时间戳单位** | **未找到权威来源，属推测** | 第三方构建时**所有表 0 行**，只能按 ACP v2 schema 猜。macOS 路径本身也是按 Rust `dirs` 约定推断的。 |
| **Devin Desktop 的 protobuf schema** | **未找到** | 第三方也未解出字段路径。 |
| **WorkBuddy 的文件格式公开文档** | **未找到** | 腾讯云文档只到产品层面（WorkBuddy Enterprise / WMA / Harness）；格式结论全部来自本机实测。 |
| **"Hermes Agent" 是否同名冲突** | 已澄清 | 与 Nous Research 的 **Hermes LLM 系列模型**是两回事。本文的 Hermes Agent 指 `github.com/NousResearch/hermes-agent`（MIT，个人 agent 平台，含 CLI/网关/桌面端/插件）。 |
| **"OpenClaw" 是否改名/同名** | 已澄清 | 是真实且活跃的项目（<https://docs.openclaw.ai>，<https://github.com/openclaw/openclaw>），与 Claude 有官方迁移路径。 |
| **"Paperclip" 同名冲突** | 已澄清 | 存在多个同名项目（含一个 HuggingFace Space 的 `paperclip-sync.py`、一个 npm `@satriachandrayw/paperclip-cli`）。本文指 `paperclipai/paperclip`（docs.paperclip.ing）。 |

### B. 明确「不建议做」的

| 工具 | 结论 | 理由 |
|---|---|---|
| **Devin Desktop** | **不做** | ① 会话是 **protobuf**（`~/.codeium/windsurf/cascade/*.pb`），不是 JSON/SQLite，逆向成本高；② 与 Windsurf **共用同一份文件**，且**文件本身无法区分来源**，会把 Windsurf 的会话误记成 Devin；③ Devin 自己的 `~/.devin` 里压根没有会话数据（实测为空）。 |
| **Devin CLI** | **暂不做** | macOS 路径未实测；`chat_message` 形状全属推测；第三方构建时全表 0 行 —— 没有任何一条经过验证的字段路径。 |
| **Paperclip** | **不做** | 不是本地 CLI 会话数据源：它是自托管服务，对话在服务端 DB（路径随部署变），且它本身是**委托**别的 agent（Claude Code / Codex / …），采集会与那些 CLI 的直接记录**重复**。需要它的数据请走官方 API。 |
| **豆包 / veCLI** | **不做** | 豆包无本地会话；veCLI 的存储路径无任何公开依据。硬做只能是猜。 |
| **Trae / TRAE SOLO（字节 IDE）** | **另案调研** | 本机装有 `Trae CN.app`（VS Code fork，MarsCode/豆包同门），布局为标准 `User/workspaceStorage/<hash>/state.vscdb`。但它是 **IDE 不是 CLI**，超出本文范围；若要做，需单独一次性验证 `state.vscdb` 里是否存在 chat 数据（Devin 桌面版的经历说明「VS Code 系布局」≠「有会话数据」）。 |

### C. 优先级建议（给下游日报工具）

**建议先做（路径与字段都已证实、格式规整、低风险）**：
1. **Claude Code** —— 用户基数最大；只有一个必踩的坑（按 `message.id` 去重）。
2. **DeepSeek Harness（dsh）** —— 本机在跑；注意 glob `session*.jsonl.zstd` + 过滤 `source.kind`。
3. **Hermes Agent** —— 官方文档给了完整字段语义；别忘 `~/.hermes/profiles/*/state.db` 和 `active=1`。
4. **Kimi Code** —— 官方文档 + 源码都齐；wire.jsonl 结构极规整。
5. **WorkBuddy** —— 本机在跑、字段已实测；但格式未公开，需防御性解析。
6. **Gemini CLI** —— 注意它已被 Antigravity CLI 取代，先确认用户实际在用哪个。

**建议先实测再决定（路径已证实，但文件级 schema 需一次实测校准）**：
7. **OpenCode** —— 官方文档与第三方实测的布局**互相矛盾**（`project/<slug>/storage/` vs `opencode.db`），
   必须先确认目标机器走哪一代。
8. **Qwen Code** —— 记录字段已证实，但**目录/文件名是推测**；一条 `ls` 就能定性。
9. **OpenClaw** —— 路径权威，但消息体 schema 未公开，需 `.schema` 一次。

**先别做**：Devin Desktop、Devin CLI、Paperclip、豆包/veCLI。
