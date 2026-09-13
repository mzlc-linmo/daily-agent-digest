# Daily Agent Digest 需求文档

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.0(已确认) |
| 日期 | 2026-09-12 |
| 代码基线 | `main` @ `1befe55`("Sign the native menu bar app before release") |
| 已发布版本 | `v0.4.11`(公共分发库 `mzlc-linmo/daily-agent-digest-distribution`) |
| 文档地位 | **本文档取代 `docs/superpowers/plans/2026-09-12-production-delivery-plan.md`,作为后续开发的需求基线**;旧交付计划仅作历史参考 |
| 相关文档 | `README.md` |

> 说明:标注「事实」的内容可在代码中定位(附文件:行号);所有范围性决策已由产品负责人确认,记录于第 12 章。

---

## 1. 背景与问题陈述

**事实**:开发者日常在多个 AI Agent 客户端中工作,会话记录分散在各自的本地存储中:

| 数据源 | 位置 | 读取方式 |
| --- | --- | --- |
| Codex | `~/.codex/thread_history_1.sqlite`、`~/.codex/archived_sessions/*.jsonl` | SQLite 查询 + JSONL(`daily_agent_digest.py:82-95`) |
| Pi agent | `~/.pi/agent/sessions/**/*.jsonl` | JSONL(`:122-125`) |
| DeepSeek Harness | `~/.dsh/sessions/**/*.zstd` | 外部 `zstd -dc` 解压后按行解析(`:110-120`) |

由此产生的核心问题:

1. **工作成果不可回溯**:一天的工作分散在多个 agent 会话中,没有统一口径的「今天做了什么」。
2. **原始记录不可直接使用**:记录含大量自动化噪音、重复内容、闲聊与个人事务,直接罗列 session 没有阅读价值。
3. **人工整理成本高**:每天需要一份「按工作主题聚类、排除非工作内容」的日报。
4. **需要可核验与可裁剪**:日报要能追溯到具体会话,并能在上报前人工剔除敏感/不相关条目。
5. **团队内缺少统一的日报出口**:**本次确认的核心场景**——3–10 人小团队需要把每人每日的 agent 工作进展自动汇总到同一个群,而不是各自零散汇报。

## 2. 产品定位与目标用户(已确认)

- **定位**:本地优先(Local-first)的 AI Agent 每日工作日报工具,面向 **3–10 人、全部 macOS、各自本地运行、无服务端** 的内部团队。每人本地采集 → 一次 LLM 主题归并 → 本地复核 → 上报到团队共享的飞书群。
- **形态**(事实):命令行引擎(Python 3.10+,PyInstaller 单文件二进制)+ macOS 菜单栏托盘应用(AppKit/Swift)+ `launchd` 定时调度。
- **部署模型**:无服务端、无账号体系、无中心数据库。每台机器独立持有 `state.json`、每日 JSON 与 `.env`;团队一致性仅通过「共享飞书群 + 统一的分发/配置说明」达成。
- **分发方式**:继续使用现有公共 GitHub release(签名 + 公证),团队成员各自执行一行安装。

## 3. 目标与非目标

### 3.1 本期目标

- G1 每日自动产出「按工作主题聚类」的日报,而非 session 流水账。
- G2 日报在本地可人工复核、逐条排除,排除项不进入上报内容。
- G3 日报自动上报到团队共享飞书群,并带成员身份标识。
- G4 一键安装、可升级、可核验安装来源;成员上手成本 ≤ 1 条命令 + 1 次配置。
- G5 运行失败必须显式可见,不得出现「失败但显示成功」。

### 3.2 本期非目标

- N1 不做服务端、账号体系、多端同步(团队级汇总看板不在本期)。
- N2 不修改任何 agent 客户端的会话数据(采集只读,`README.md:58`)。
- N3 不做逐轮对话的实时分析(定位是「每日」粒度)。
- N4 不做历史日报浏览与周报/月报(仅当天)。
- N5 **不做 Windows 客户端功能对等**(本期只交付 macOS;`native/windows/` 保持「可编译」状态,不参与验收)。
- N6 不做不可逆的源码保护(PyInstaller 只打包字节码,`README.md:42`)。

## 4. 术语

| 术语 | 含义 |
| --- | --- |
| 事件(event) | 从某个数据源采集到的一条记录,含 `provider/session_id/item_id/timestamp/kind/text/dedupe_key`(`:127-129`) |
| 工作项(work item) | LLM 归并出的工作主题,含 `id/title/details/status/source_task_ids/excluded` |
| 报告(report) | 某一天的结构化结果,含 `summary` + `work_items`,落盘为 `YYYY-MM-DD.json` 与 `state.json` |
| 上报(submit) | 把未排除的工作项投递到团队飞书群(`:194-203`,本期改为飞书适配) |
| 成员身份(member) | 上报载荷中的提交人标识(姓名或工号),本期新增 |
| 引擎(engine) | `daily_agent_digest.py` 及其打包后的 `daily-agent-digest` |
| 应用(app) | macOS 托盘控制器 `Daily Agent Digest *.app` |
| DIGEST_HOME | 应用数据目录,默认 `~/.local/share/daily-agent-digest`(`:6`) |

## 5. 需求

优先级:**P0** = 缺失即不可交付;**P1** = 本期应完成;**P2** = 可延后。

### 5.1 功能性需求

#### FR-1 数据采集(P0,范围已确认)

- FR-1.1 按「本地日历日」窗口采集,窗口为 `[当天 00:00, 次日 00:00)`(`:68-70`)。
- FR-1.2 时间戳兼容毫秒/秒级 epoch 与 ISO8601(含 `Z`),统一换算到报告时区(`:72-80`)。
- FR-1.3 采集根目录必须可通过 `DIGEST_SOURCE_ROOT`(引擎)与 `--root`(CLI)覆盖,测试不得读取真实用户主目录(`:162`、`:206`)。
- FR-1.4 provider 固定为 `codex`、`pi`、`deepseek-harness` 三个;本期不新增数据源,但采集器边界须可扩展。
- FR-1.5 采集只读;任一数据源缺失、损坏、无权限时降级跳过,不得中断整体生成(`:101`、`:113-114`)。
- FR-1.6 单条事件文本截断上限集中定义(当前 4000 字符,`:90`、`:107`、`:119`)。
- FR-1.7 依赖 `zstd` 可执行文件时,安装器必须检测并给出明确提示(当前仅在 README 声明)。

#### FR-2 去重与 token 预算(P0)

- FR-2.1 按确定性指纹去重(`provider|session|item|text` 的 SHA256,`:127-132`)。
- FR-2.2 送 LLM 的上下文同时受「条数」与「字符数」双重约束(当前:前 500 条、每条约 900 字符、总 30000 字符,`:146-148`)。
- FR-2.3 预算常量集中定义并可被测试断言;目标值上调为「单条摘要 ≤900 字符、单次请求 ≤90000 UTF-8 字符、工作项 ≤20 条」(与现实现不一致,见 D-5)。
- FR-2.4 送 LLM 前必须完成本地去重与截断,不得发送全量原始记录。
- FR-2.5 **选材必须先于预算(已确认并实现)**:只按采集顺序取前 N 条会让冗长的机器输出吃光预算,真实工作被整体挤掉。规则为:
  1. 本地去重(指纹相同只留一条);
  2. **本地排除自动化记录**(定时脚本 / `automation_*`),不占用模型预算,也不指望模型过滤;
  3. 按信号分层:高信号(`userMessage`/`agentMessage`/`assistant/message`/`reasoning`)→ 未知 → 低信号(工具输出、命令执行、流程事件);
  4. **各来源之间轮转取样**,任一来源的体量都不能把别的来源挤掉;
  5. 预算 **90,000 字符**(FR-2.3 的目标值),单条摘录 ≤900 字符;
  6. 统计写入 `coverage.context`,并输出一行人类可读的 `coverage_note`(同时写入 `state.coverage_note`):「当天采集 N 条 → 去重 N 条;排除自动化 N 条;送模型 N 条/N 字符;因预算省略:<来源 N 条>」,界面底部显示该行。

#### FR-3 LLM 主题归并(P0)

- FR-3.1 使用一次「当日单次」LLM 调用完成主题聚类(OpenAI 兼容 `/chat/completions`,`:149-153`)。
- FR-3.2 提示词要求:按工作主题聚类而非按 session 列出;只保留真实工作内容;排除个人问题、娱乐、闲聊、自动化噪音。
- FR-3.3 必须要求严格 JSON(允许从响应中提取首个 `{` 到末个 `}`),禁止依赖 Markdown。
- FR-3.4 输出工作项字段:`title`、`details`、`status`(completed/in_progress/blocked)、`source_task_ids`;可选 `summary/decisions/blockers/next_steps`。
- FR-3.5 工作项数量 3–20 个,同一主题合并(当前硬截断 20,`:155`)。
- FR-3.6 工作项 `title` 必须是可读工作主题,不得出现 session ID。
- FR-3.7 LLM 不可用或返回畸形时降级为「按 provider 分组」的兜底结果,并在输出中显式标记为未分类/降级(`:137`、`:158`)。
- FR-3.8 必须持久化 `last_error` 与 `coverage.limitations`。
- FR-3.9 请求超时显式设置(当前 120s,`:152`);必须加载系统 CA 证书以支持企业代理/自签链场景(`:37-43`)。
- FR-3.10 **已确认**:每名成员使用自己的 `LLM_API_KEY` 直连公网端点(默认 `https://api.deepseek.com/v1`),不使用团队网关或共享 key;因此安装/设置流程必须让成员可自助填写与更换 key(见 FR-11)。
- FR-3.11 **日报形态(已确认,结构化)**:日报 = **工作项数组**,每一项自带标题与正文 `{"title": "…", "desc": "…", "status": "…", "source_task_ids": [...]}`。界面上的「工作总结」区就是把**未排除的项**按顺序渲染成「标题 + 内容」;不存在独立的自由叙述字段。这样拆分带来三个直接好处:排除一项 = 从数组里去掉一项,**不调用 LLM、毫秒级完成、完全可逆**,也不需要维护"完整版/裁剪版"两份文本。
  - `title` ≤30 字;`desc` 是该项完整而独立的说明(做了什么、为什么做、怎么做的、结果或产出),目标 **100–300 字**。
  - 整份日报 = 所有 `title` + 所有 `desc`,合计 **≤1000 字**,不设下限。
  - 预算在各项之间平均分配:项少时每项可写满 300 字,项多时相应压缩,**任何情况下都不删除工作项**。
  - 长度由引擎在解析响应后本地裁剪(超长标题裁到 30 字、正文按可用预算裁剪并优先在句号处收尾),不依赖模型自律;输出 `report_chars` 便于核对。
- FR-3.12 `title` 要求:可读的工作主题,不得出现 session ID,不得只是复述 `desc` 的第一句。
- FR-3.13 **禁止用 LLM 重写来做排除**:排除必须只做数组过滤。历史方案(让 LLM 删除被排除主题的句子)已被否决,原因见 D-24。

- FR-4.1 `state.json` 必须包含稳定 schema(当前 `schema_version:1.1`):`date`、`summary`、`work_items`、`generated_at`、`report_status`、`last_error`、`reports`、`release_version`、`submitted_count`(`:46`、`:165`)。
- FR-4.2 `report_status` 取值:`not_generated` / `generating` / `ready` / `submitted` / `error`。**新增约束**:上报通道未配置或未启用时,不得进入 `submitted`(见 FR-7.2 与 D-1)。
- FR-4.3 写入原子(临时文件 + `os.replace`),权限 `0600`(`:31`)。已满足。
- FR-4.4 重新生成某天前只清除该天生成内容,且**保留该天已有排除选择**(`:163-164`)。
- FR-4.5 每日报告落盘为 `YYYY-MM-DD.json`(`DIGEST_OUTPUT_DIR`,默认 APP_DIR,`:211-212`)。
- FR-4.6 `state.json` 与日志中不得出现 API Key、飞书签名密钥或请求头(`:44-47`、`:208-209`)。已满足。
- FR-4.7 调试日志仅在 `DIGEST_DEBUG=1` 时写入(`:33-35`)。已满足。

#### FR-5 应用命令协议(app-command)(P0)

- FR-5.1 引擎支持命令:`settings`、`save-settings`、`clear`、`generate`、`state`、`exclude`、`restore`、`submit`、`tick`(`:169-192`)。**本期新增**:`save-settings` 接受 `member`、`feishu_webhook`、`feishu_secret`、`schedule_time`、`api_key`。
- FR-5.2 协议形态:参数 `--app-command <name>`,stdin 传 JSON,stdout 输出单行 JSON。
- FR-5.3 每个命令必须返回合法 JSON;**失败返回 `{"error": "..."}` 且退出码非 0**(`:207-209`)。
- FR-5.4 未知命令返回结构化错误(已满足)。
- FR-5.5 `exclude` / `restore` 对未知 `id` 必须报错且不修改状态(`:186-187`,已满足)。
- FR-5.6 `submit` 只包含未排除项(`:197`),且已上报后重复 `submit` 幂等(`:196`,已满足)。

#### FR-6 排除与恢复(P0)

- FR-6.1 可逐条排除/恢复工作项,排除状态持久化在 `state.json`。
- FR-6.2 排除状态在重新生成后仍生效(依赖 FR-4.4)。
- FR-6.3 工作项 `id` 必须稳定可复现;当前 `sha256(title + day)` 在标题措辞变化时失效(见 D-7),必须改进为「主来源会话 + 主题指纹」的稳定标识。

#### FR-7 上报到飞书群(P0,本期重点)

- FR-7.1 **通道**:飞书自定义机器人(群 webhook),端点形态 `https://open.feishu.cn/open-apis/bot/v2/hook/{token}`;token 由团队统一提供,通过安装参数或托盘设置写入 `.env`。
- FR-7.2 **未配置 webhook 时不得标记为已上报**(已实现):`submit` 保持 `report_status: ready`,写入 `submit_status: not_configured` 与 `submit_error` 说明;日报字数与内容不受影响,配置通道后可重试。
- FR-7.3 **响应码校验**:飞书在业务失败时可能返回 HTTP 200 且响应体 `code != 0`,必须解析响应体并校验 `code == 0` 才算成功。
- FR-7.4 **签名校验**:当团队启用了「签名校验」安全设置时,请求体必须包含 `timestamp`(秒级)与 `sign`;`sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, data = ""))`。未配置 secret 时按飞书默认的「无签名」模式发送。
- FR-7.5 **成员标识**:上报载荷必须包含成员标识(`member`,姓名或工号,来自设置),消息正文中必须可见提交人,以便群内区分谁提交。
- FR-7.6 **消息内容**:至少包含日期、成员、工作总结摘要,以及未排除工作项(标题 + 状态);条数过多时须截断并注明「完整明细见本机报告」。
- FR-7.7 **失败语义**(已实现):网络错误、非 200、`code != 0`、超时(30s)都写入 `submit_status: failed` + `submit_error` + `last_error`,**保持非 `submitted`**,并允许重试。
- FR-7.8 **幂等**:重复 `tick`/`submit` 不得重复发送同一天的消息;已成功后直接返回当前状态。
- FR-7.9 **限流**:遵守飞书自定义机器人限流,失败退避重试有上限,不得无限重试。
- FR-7.10 上报内容不包含 `source_task_ids` 之外的原始会话正文;不得把完整会话文本发到群里。

#### FR-8 调度(P0,已确认可变)

- FR-8.1 macOS 通过 `launchd` 安装两个服务:引擎日报任务 `com.daily-agent-digest`(默认每日 18:00)与托盘应用 `com.daily-agent-digest.tray`(`RunAtLoad`)(`install.sh:102-125`)。
- FR-8.2 引擎 `tick` 语义:预览时间后首次 tick 触发生成,终版时间后状态为 `ready` 时触发一次上报(`:178-182`)。
- FR-8.3 **时区固定 UTC+8**(已确认),但**日报时间必须在托盘设置界面可配置**(默认 18:00,预览默认提前 30 分钟)。修改后必须重写 `launchd` plist 并重载服务,使计划任务真正生效——不能只改界面或只改 `tick` 逻辑。
- FR-8.4 重复安装/升级后必须**恰好一个**托盘进程与一个启动项(见 D-3)。
- FR-8.5 调度时间配置需持久化(建议写入 `.env` 或 `state.json`),重装后保留。

#### FR-9 macOS 托盘 UI(P0)

- FR-9.1 菜单项:查看今日总结、生成今日总结、设置、退出(`DailyAgentDigest.swift:170`)。
- FR-9.2 报告窗口展示:日期、工作主题数、**合计字数/上限**、状态、引擎版本、UI 构建号;**完整的工作总结**;工作主题列表(**仅标题** + 排除/恢复按钮);底部状态行。
- FR-9.10 **工作总结必须完整可见**:总结区高度按内容自适应(实测 655 字 / 3 段 → 249pt),在窗口可容纳范围内**不出现滚动、不截断**;只有超出窗口上限时才滚动。工作项正文已取消,行长不再受正文长度影响。
- FR-9.12 **排除必须在工作总结中立即生效**:点击索引里某行的 × 后,该行的**标题与内容整体从工作总结中消失**(其余项的文字一字不改),顶栏「共 N 项(已排除 M 项)」与「计入上报 X 字」同步更新;恢复后该项整块回到总结中。整个过程只做数组过滤,**不得调用 LLM、不得重新生成、不得等待网络**;本地状态先更新,再写回引擎,写回失败则回滚到引擎状态并提示原因。
- FR-9.13 **「工作主题」是索引而非第二份正文**:该列表只显示标题、字数与排除开关,已排除项以灰色标题 + 橙色「已排除」+「恢复」按钮标识;正文只在工作总结区出现一次,避免重复。
- FR-9.11 **报告窗口必须置顶可见**:菜单栏(accessory)应用仅靠 `NSApp.activate` 不会超过前台常规应用,点击「查看今日总结」后必须 `makeKeyAndOrderFront` + `orderFrontRegardless`,不得被浏览器/聊天窗口遮挡(历史缺陷 D-23)。
- FR-9.3 生成流程 `clear → 显示进度 → generate → 成功/失败`;进度控件仅在工作期间存在,成功后移除 accessory 并仅在此时启用「查看今日总结」(`:172-183`)。
- FR-9.4 **生成失败必须显示失败**:当前只检查返回体的 `error` 键,而 LLM 失败时引擎返回的是 `report_status=error` 的状态体 → UI 误报成功(见 D-2)。判定必须同时检查 `error`、`report_status` 与 `last_error`。
- FR-9.5 后端调用必须排空 stdout、捕获 stderr、设置超时,并把结构化错误呈现到 UI(当前无 stderr 捕获、无超时,`:30-49`;`tray.error.log` 已出现 `BrokenPipeError`)。
- FR-9.6 关闭窗口只隐藏不退出;「退出」终止单实例且定时器不得再创建进程(`:200`)。
- FR-9.7 UI 必须能自证版本(引擎 release + UI build id,`:135`、`:138`)。
- FR-9.8 **新增**:设置界面除 Base URL / Model 外,还必须支持 API Key、成员标识、飞书 webhook(及可选 secret)、日报时间;API Key 与 secret 只写不回显。
- FR-9.9 **新增**:上报结果必须在 UI 中可见(成功含发送时间,失败含错误原因),禁止静默失败。

#### FR-10 Windows 托盘客户端(本期不做,P2)

- FR-10.1 记录为后续需求:与 macOS 对等的报告窗口(摘要、工作项、详情、状态、排除/恢复、进度、成功/失败)、设置回填与 JSON 转义、单实例、单一启动项、升级先停旧进程。
- FR-10.2 现状:`native/windows/DailyAgentDigestTray.cs` 仅 9 行,只在 `MessageBox` 弹原始 JSON,无报告窗口、无排除、无调度;CI 仅验证「能编译出 exe」(`.github/workflows/build-release.yml:9-19`)。
- FR-10.3 本期只要求:不因 Windows 代码破坏 macOS 交付;Windows CI job 保持绿。

#### FR-11 设置与凭据(P0)

- FR-11.1 `.env` 保存 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`,权限 `0600`(`:53-66`、`install.sh:75-77`)。已满足。
- FR-11.2 安装器必须保留已存在的 `.env`(重装不覆盖、不丢 key,`install.sh:78-86`)。已满足。
- FR-11.3 `settings` 命令只返回 `api_key_set` 布尔值,绝不回显 key 或 secret(`:50`)。已满足。
- FR-11.4 **已确认**:托盘设置内必须可更换 API Key(解决 README「Key 只能在安装时输入」与实际使用不符的问题),写入后权限仍为 `0600`。
- FR-11.5 `.env` 解析必须兼容历史错误引号格式(`:16-21`、`install.sh:79-84`)。
- FR-11.6 **新增**配置项:`DIGEST_MEMBER`(成员标识)、`DIGEST_FEISHU_WEBHOOK`、`DIGEST_FEISHU_SECRET`(可选)、`DIGEST_SCHEDULE_TIME`(默认 `18:00`);安装器可在非交互模式下通过环境变量注入,托盘设置可修改。

#### FR-12 安装与升级(P0)

- FR-12.1 一行安装:`curl -fsSL .../install.sh | sh`(`README.md:16`)。
- FR-12.2 仅支持 macOS,按 `uname -m` 选择 arm64 / x86_64 资产(`install.sh:11-12`)。
- FR-12.3 同一版本内完成下载 → 校验 SHA256 → 校验代码签名(Developer ID Application)→ 落地(`install.sh:26-35`)。
- FR-12.4 版本一致性:必须先解析并固定 release tag,所有资产来自同一 release(现实现对每个资产各自 cache-bust,存在混版风险,`install.sh:19-27`)。
- FR-12.5 升级原子性:全部校验通过后再替换;任一步失败必须保持旧版本可用(当前引擎在 app 校验前就被 `mv` 覆盖,见 D-3)。
- FR-12.6 写入 `install-manifest.json`,含 release tag、架构、引擎/应用 SHA256、安装时间(`install.sh:96-101`)。已满足。
- FR-12.7 清理临时文件(当前下载早于 `trap` 注册,失败/中断会残留 `.daily-agent-digest-*`、`.SHA256SUMS.*`,见 D-4)。
- FR-12.8 避免宽泛 `pkill` 模式误杀无关进程(`install.sh:16`)。
- FR-12.9 **新增(团队场景)**:必须提供团队安装说明(获取软件、输入自己的 LLM Key、填写姓名与团队飞书 webhook、验证上报);成员首次安装的交互式输入项不超过 3 项。

#### FR-13 发布与供应链(P1)

- FR-13.1 CI 在 tag `v*` 时构建双架构、跑测试、签名、公证、生成 `SHA256SUMS`(`.github/workflows/build-release.yml`)。
- FR-13.2 发布资产为显式清单:两个引擎二进制、两个 app zip、`install.sh`、`SHA256SUMS`;禁止目录或宽泛 glob。
- FR-13.3 发布后必须审计公共资产(`scripts/release-audit.sh` 已存在,但未接入 workflow,见 D-9)。
- FR-13.4 公共分发仓库 `mzlc-linmo/daily-agent-digest-distribution`(事实:已有 `v0.4.3`–`v0.4.11`)。
- FR-13.5 非 tag 的手动触发只产出 draft 预发布(已满足,`build-release.yml:112-114`)。

#### FR-14 团队运营要求(P1,新增)

- FR-14.1 安装说明必须包含「如何确认自己上报成功」(状态、`submitted_count`、飞书群消息)。
- FR-14.2 团队需统一约定飞书机器人配置(群、是否开启签名校验、是否有 IP/关键词白名单)并在文档中记录。
- FR-14.3 成员更换机器或重装后,`.env` 中的成员标识与 webhook 必须可迁移(文档说明需保留的文件)。
- FR-14.4 隐私披露:必须明确告知成员「会话摘录会发送到公网 LLM 端点,日报摘要会发送到团队飞书群」,并说明排除功能的使用方式。
- FR-14.5 本期不做本地脱敏与关键词过滤(已确认),该风险记录于第 10 章并作为后续可选项。

### 5.2 非功能性需求

| 编号 | 类别 | 需求 | 现状 |
| --- | --- | --- | --- |
| NFR-1 | 性能 | 单日生成(采集 + LLM)在 2 万条事件量级下 ≤ 3 分钟;单源阻塞不得拖垮整体 | 事实:2026-09-12 采集 1674 条事件,`launchd.log` 正常 |
| NFR-2 | 性能 | 托盘启动到可交互 ≤ 2 秒;`state` 命令 ≤ 2 秒 | 未测量 |
| NFR-3 | 隐私 | 采集只读;仅在配置 LLM 后外发;`.env`/`state.json`/日志权限 `0600` | 部分满足 |
| NFR-4 | 隐私 | 日志与状态中不得出现 API Key 或飞书签名 secret | 满足 |
| NFR-5 | 安全 | 安装校验 SHA256 + 签名;webhook 必须 HTTPS;支持飞书签名校验模式 | 部分满足 |
| NFR-6 | 可靠 | 任何失败不得产生「假成功」;错误持久化且 UI 可见 | **不满足**,见 D-1/D-2 |
| NFR-7 | 可靠 | 安装/升级可重入,重复执行后收敛为 1 进程、1 启动项、1 manifest | **不满足**,见 D-3 |
| NFR-8 | 可观测 | `DIGEST_DEBUG=1` 时输出 provider/协议/上报错误到 `debug.log` | 满足 |
| NFR-9 | 可追溯 | 运行中的应用可自证 release tag、引擎 hash、UI build id、架构 | **部分满足**,见 D-6 |
| NFR-10 | 兼容 | macOS 15+;Python 3.10+ 源码运行;需 `zstd` | 满足 |
| NFR-11 | 可维护 | 单文件引擎 + 原生薄客户端;app-command 为稳定 JSON 契约 | 满足 |
| NFR-12 | 可测试 | 协议、预算、去重、降级、排除、上报、安装、UI 冒烟必须有自动化测试 | **不满足**,当前仅 1 个用例 |
| NFR-13 | 易用 | 成员从拿到安装命令到首次成功上报 ≤ 10 分钟,无需阅读源码 | 未验证 |

## 6. 接口与数据契约

### 6.1 app-command 协议

```
<input>  := 单行 JSON 对象(可含 date、source_root、id、base_url、model、api_key、member、
             feishu_webhook、feishu_secret、schedule_time)
<output> := 单行 JSON 对象;失败时 {"error": "<message>"} 且退出码非 0
```

| 命令 | 输入 | 输出 | 副作用 |
| --- | --- | --- | --- |
| `settings` | `{}` | `{base_url, model, api_key_set, member, feishu_configured, schedule_time}` | 无 |
| `save-settings` | 上述配置子集 | settings 结果 | 写 `.env`(0600);改时间时重载 launchd |
| `clear` | `{date?}` | state | 清空该日工作项与摘要、置 `generating` |
| `generate` | `{date?, source_root?}` | state | 采集 + LLM + 落盘 |
| `state` | `{date?}` | state | 无 |
| `exclude` / `restore` | `{date?, id}` | state | 更新排除标记 |
| `submit` | `{date?}` | state | POST 到飞书群(未配置时报错,见 FR-7.2) |
| `tick` | `{date?}` | state | 预览时间后生成;终版时间后上报 |

### 6.2 state.json 契约(建议升至 schema_version 1.2)

```json
{
  "schema_version": "1.2",
  "release_version": "v0.4.11",
  "date": "YYYY-MM-DD",
  "member": "张三",
  "summary": "string",
  "work_items": [
    {"id":"hex16","title":"工作主题","desc":"该项完整说明","status":"completed|in_progress|blocked",
     "source_task_ids":["provider/session"],"excluded":false,"chars":152}
  ],
  "report_chars": 669,
  "included_count": 5,
  "excluded_count": 1,
  "generated_at": "ISO8601",
  "report_status": "not_generated|generating|ready|submitted|error",
  "last_error": "string|null",
  "reports": ["YYYY-MM-DD"],
  "submitted_count": 0,
  "submit_status": "submitted|not_configured|failed|null",
  "submit_error": "string|null",
  "submitted_at": "ISO8601|null"
}
```

### 6.3 飞书上报请求

```
POST https://open.feishu.cn/open-apis/bot/v2/hook/{token}
Content-Type: application/json

{
  "timestamp": "1736568000",          // 启用签名校验时必填
  "sign": "base64(hmac_sha256(timestamp + "\n" + secret, ""))",
  "msg_type": "text" | "interactive",
  "content": { ... }                   // text: {"text": "..."};interactive: 卡片结构
}
```

判定成功:HTTP 2xx **且** 响应体 `code == 0`。

### 6.4 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DIGEST_HOME` | 应用数据目录 | `~/.local/share/daily-agent-digest` |
| `DIGEST_SOURCE_ROOT` | 采集根目录 | `$HOME` |
| `DIGEST_OUTPUT_DIR` | 报告输出目录 | `APP_DIR` |
| `DIGEST_RELEASE_VERSION` | 写入状态的版本号 | `dev` |
| `DIGEST_MEMBER` | 上报用成员标识 | 空(必须配置) |
| `DIGEST_FEISHU_WEBHOOK` | 飞书群机器人 webhook | 空(未配置则不上报) |
| `DIGEST_FEISHU_SECRET` | 飞书签名校验 secret(可选) | 空 |
| `DIGEST_SCHEDULE_TIME` | 每日日报时间(`HH:MM`,UTC+8) | `18:00` |
| `DIGEST_DEBUG` | `1` 时写调试日志 | 空 |
| `DIGEST_ENGINE` | 托盘调用的引擎路径 | `APP_DIR/daily-agent-digest` |
| `DIGEST_RELEASE_BASE` | 安装源基址 | GitHub latest/download |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | OpenAI 兼容端点配置 | `https://api.deepseek.com/v1` / `deepseek-flash` / 无 |

> `DIGEST_SUBMIT_URL` 被 `DIGEST_FEISHU_WEBHOOK` 取代;如需保留通用 HTTP 上报能力,可作为 P2 的可选适配器。

## 7. 验收标准(Definition of Done)

- A1 干净 macOS 机器执行公共一行安装后,`install-manifest.json` 的 tag 与目标 release 一致。
- A2 托盘运行中重跑安装器后,`pgrep` 恰好 1 个托盘进程,`~/Library/LaunchAgents` 恰好 1 个 tray plist。
- A3 篡改 SHA256 时安装中止,且旧版本仍可用。
- A4 全部 app-command 返回合法 JSON 或结构化错误;`state.json`/日志不含 API Key 或飞书 secret。
- A5 `clear → generate` 后该日旧内容被替换、排除选择保留、状态依序 `generating → ready|error`。
- A6 LLM 失败或返回畸形时明确标记降级,UI 显示「生成失败」,`last_error` 非空。
- A7 工作项标题为可读工作主题,不含 session ID。
- A8 报告窗口可见摘要、标题、详情、状态、排除控件与错误信息;成功后对话框无进度条。
- A9 `python -m unittest discover -s tests -v` 全绿,覆盖协议/预算/去重/降级/排除/安装/上报。
- A10 CI 通过 Python 测试、Swift 编译 + UI 冒烟、双架构构建、签名校验、公证、SHA256 与发布资产审计。
- A11 公共 release 资产清单完整(2 二进制 + 2 app zip + `install.sh` + `SHA256SUMS`)。
- A12 `scripts/release-audit.sh` 通过并接入 CI。
- **A13** 配置 webhook 与成员标识后执行 `submit`,团队飞书群收到消息,且消息中可见成员、日期、摘要与工作项。
- **A14** 未配置 webhook 时执行 `submit` 或 `tick`,状态不得变为 `submitted`,且 `submit_status=not_configured`、`submit_error` 非空(回归 D-1,已由 3 项测试覆盖)。
- **A15** 上报失败(网络错误或 `code != 0`)时状态保持 `ready`、`submit_status=failed`、`submit_error` 非空、UI 可见失败、重试可成功。
- **A16** 在托盘设置中把日报时间改为其他时间后,`launchd` 实际触发时间随之改变(重启后仍生效)。
- **A17** 托盘设置面板可更换 API Key,保存后 `.env` 权限仍为 `0600`,`settings` 不回显明文。
- **A18** `native/macos/ui-smoke-test.sh` 通过并接入 CI:编译 bundle 后运行 `--self-test`,断言 `ready/submitted` 判为成功、`report_status=error`、缺失 `last_error`、`error` 键、`generating`、空状态、陈旧 `last_error` 均判为失败(防止 D-2 回归)。
- **A19** 生成过程中主队列不被阻塞:`clear`/`generate` 的调用与完成均在进度面板显示期间正常执行,`tick` 定时器持续触发,结果弹窗必定带可见按钮(防止 D-19 回归)。
- **A20** 日报形态与字数:任意输入下 `report_chars` ≤1000 且等于**未排除项**的 `title + desc` 之和;3 项时每项正文可写满 100–300 字;20 项时全部保留且总量仍 ≤1000。
- **A21** 报告窗口中工作总结按「标题 + 内容」渲染全部未排除项并**完整可见**(按内容自适应高度),工作主题索引只显示标题,正文不重复出现。
- **A27** 上下文选材:自动化记录在本地被排除;高信号(人的消息/助手叙述)先于机器输出进入预算;任一来源都不会被另一个来源挤空;实际上下文 ≤ 预算;`coverage_note` 记录采集/去重/排除自动化/送模型/省略各来源的条数并在界面显示(6 项回归测试)。
- **A22** `--mode=verbose` 注入超长总结与超长标题时,引擎仍裁剪到 ≤1000 字、标题 ≤30 字,且工作项数量不变。
- **A23** 报告窗口在浏览器/聊天应用处于前台时仍可见(置顶),不被遮挡。
- **A24** 排除反应:排除一项后,该项的标题与内容立即从工作总结中消失且**其余项文字不变**(`--self-test` 断言)、`report_chars` 相应减少、索引行变为「已排除/恢复」;恢复后整块回到总结;全部排除时工作总结显示"没有可上报的内容"。
- **A26** 排除不调用 LLM:在没有配置任何 `LLM_*` 变量的环境下执行 `exclude`/`restore` 必须成功且不报错(回归测试覆盖)。
- **A25** 排除写回失败时界面回滚到引擎实际状态,并显示失败原因。

## 8. 需求与现状差距总览

| 编号 | 差距 | 关联需求 | 优先级 |
| --- | --- | --- | --- |
| D-1 | 未配置上报地址时 `submit` 仍置 `submitted`,假成功 | FR-7.2 | P0 |
| D-2 | LLM 失败时 UI 误报「生成成功」 | FR-9.4 / NFR-6 | **已修复**:新增 `Backend.failureReason` 同时检查 `error`/`last_error`/`report_status`,`--self-test` 覆盖 8 种状态映射 |
| D-3 | 安装非原子:引擎先替换、app 后校验;失败即版本错配;`pkill -f` 偏宽 | FR-12.5 / FR-8.4 | P0 |
| D-4 | 安装临时文件泄漏(下载早于 `trap` 注册) | FR-12.7 | P1 |
| D-5 | token 预算未达目标(30000 字符 vs 90000 目标) | FR-2.3 | **已修复**:预算提到 90,000 字符,单条摘录上限 900 字符 |
| D-6 | 版本可追溯不完整:引擎调度路径不注入 `DIGEST_RELEASE_VERSION`(仅托盘 plist 注入);二进制未内嵌版本 | NFR-9 | P1 |
| D-7 | 排除项身份依赖 `sha256(title+day)`,标题措辞变化导致排除丢失 | FR-6.3 | P1 |
| D-8 | `clear` 后若生成未执行,状态永久停留 `generating` | FR-4.2 | P1 |
| D-9 | 发布后审计脚本未接入 CI | FR-13.3 | P1 |
| D-10 | 无飞书上报适配器(`DIGEST_SUBMIT_URL` 为通用 POST 占位) | FR-7 | P0 |
| D-11 | 无成员标识字段与上报身份 | FR-7.5 | P0 |
| D-12 | 调度时间硬编码,托盘设置无法改变实际触发时间 | FR-8.3 | P0 |
| D-13 | 托盘设置不能更换 API Key,与 README 声明不匹配 | FR-11.4 | P0 |
| D-14 | 自动化测试仅 1 个用例,UI 冒烟/安装/上报测试缺失 | NFR-12 | P0 |
| D-15 | 托盘后端无超时、无 stderr 捕获,已观测 `BrokenPipeError` | FR-9.5 | **已修复**:按命令设置超时(`state` 60s / `generate` 600s)、看门狗 terminate、捕获 stderr 并回传到 UI 错误文案 |
| D-16 | 上报结果在 UI 不可见,无法确认是否送达 | FR-9.9 | P1 |
| D-17 | Windows 客户端功能缺失 | FR-10 | P2(本期明确不做) |
| D-18 | 送 LLM 的上下文只带 `[provider] 正文`、不含 session id,模型只能编造 `source_task_ids`(实测返回 `codex/default`),来源可追溯性失效 | FR-3.4 / FR-3.6 | P1 |
| D-19 | 生成弹窗是在运行中改结构,且 `runModal()` 会阻塞串行主队列:实测日志显示排队中的 `clear` 调用始终未执行,弹窗留下冻结的进度条、两个按钮全被隐藏、`tick` 定时器停止、应用卡死 | FR-9.3 / FR-9.4 / A8 | **已修复**:进度改为非模态 `NSPanel`,结果使用独立 `NSAlert`;定时器注册到 `.common` 模式;不再在已运行的 alert 上改按钮/accessory |
| D-20 | 报告窗口把正文截断成一行(行高固定 62px、正文标签 22px 且 `byTruncatingTail`),100–300 字的正文实际只显示约 40 字,导致"日报看起来不够详细" | FR-9.2 / FR-9.10 / A21 | **已修复**:按内容自适应行高 + 完整换行显示 + 行内字数 + 顶部合计字数 |
| D-21 | 日报长度无契约:提示词只要求"简洁",实际 3 项合计 539 字且每项 118–194 字,长度不可预期也不可验证 | FR-3.11 / A20 | **已修复**:提示词写明 1000 字上限与 100–300 字/项,引擎本地二次裁剪,输出 `report_chars` 与每项 `chars` |
| D-22 | 报告窗口正文渲染不正确,连续三次返工:① 手写行高公式与渲染取到不同宽度 → 正文被裁成一行;② 改用 `usesAutomaticRowHeights` + Auto Layout 后,单列 `NSTableColumn` 退回默认宽度(约 100pt)→ 正文被挤进约 60pt 窄栏逐字换行、`×` 按钮停在窗口中间 | FR-9.10 / A21 | **已修复**:行高与单元格帧统一由 `contentWidth()`(取自 `NSScrollView.contentSize`)派生,列宽显式同步为同一值并关闭自动列宽,文本高度改用 `NSLayoutManager` 测量。实测 `column=802 body=778`,正文铺满并按内容换行 |
| D-23 | 报告窗口被前台应用遮挡:accessory 应用仅靠 `NSApp.activate` 不会置顶,`查看今日总结` 后窗口可能整体藏在浏览器/聊天窗口之后 | FR-9.11 / A23 | **已修复**:`makeKeyAndOrderFront` + `orderFrontRegardless` |
| D-24 | 用 LLM 改写总结来实现排除:慢(~10 秒)、要花钱、不可逆、每次结果不稳定,还要维护 `summary_full`/缓存两份文本 | FR-3.13 / Q17 | **已否决并移除**:改为结构化工作项数组,排除即数组过滤(实测 106ms) |
| D-25 | **app bundle 只签名、从未公证**,引擎二进制公证后也未 staple。`spctl -a -vvv -t exec` → `rejected, source=Unnotarized Developer ID`;`syspolicy_check distribution` → `Notary Ticket Missing`。已确认 v0.4.11 同样如此,**不是 v0.5.0 引入** | FR-13.1 / FR-12.3 / A12 | **后续迭代(P2)**:本期只记录不改动,细节与修复方向见 8.1 |
| D-26 | **上下文按采集顺序截断,真实工作被整体挤掉**:实测 281 条事件只有 34 条进得去且全部来自 codex,deepseek-harness 的 214 条 100% 缺席;送进去的前 12 条全是 `functionCallOutput` 自动化输出,于是日报只产出自动化工作项 | FR-2.5 / A27 | **已修复**:本地排除自动化 + 按信号分层 + 来源轮转 + 90k 预算。同一份数据修复后:326 条 → 排除自动化 46 条 → 送模型 158 条(codex 32 + dsh 126),日报产出 5 项真实工作 |

### 8.1 D-25:app bundle 公证缺口(已确认,暂缓)

**证据**(2026-09-13,针对已发布的 v0.5.0 公共资产):

```
Daily Agent Digest arm64.app: rejected
  source=Unnotarized Developer ID          ← app bundle 未公证
  origin=Developer ID Application: Jeen Tsway (LN7XF9MWY3)
syspolicy_check distribution daily-agent-digest-macos-arm64
  Notary Ticket Missing                    ← 引擎二进制已 Accepted 但未 staple
对照 v0.4.11:同样的 Unnotarized Developer ID → 历史遗留
```

**根因**:`scripts/ci-notarize.sh` 只对 `dist/$asset`(引擎二进制)调用 `notarytool submit`,app bundle(`dist/Daily-Agent-Digest-$BUILD_ARCH-app.zip`)从未提交给 Apple;整条流水线也没有 `xcrun stapler staple` 步骤。`install.sh` 只断言代码签名存在,未断言公证通过。

**影响**:

- 正常安装路径(`curl | sh`)下载的文件不带 `com.apple.quarantine`,Gatekeeper 不会拦截,所以现有用户未受影响。
- 用浏览器下载 app zip 后首次启动会被 Gatekeeper 拦下("Unnotarized Developer ID")。
- 断网环境下首次启动引擎时,因无本地票据可能校验失败。
- 发布说明中"Developer ID signed and **notarized** macOS binaries and menu-bar app"对 app bundle 而言不准确。

**修复方向**(下个迭代):`ci-notarize.sh` 增加 app bundle 的提交与等待;对引擎二进制与 app bundle 执行 `xcrun stapler staple`;发布前用 `spctl -a -t exec` 断言 `Accepted` 作为流水线门禁;同步修正 release notes 文案。


## 9. 里程碑建议

| 里程碑 | 内容 | 出口标准 |
| --- | --- | --- |
| M1 正确性与协议 | D-1、D-2、D-8、D-11 + 协议/预算/去重/降级/排除测试 | A4、A5、A6、A9 |
| M2 飞书上报 | D-10、D-11、D-16:飞书适配器(含签名与 `code` 校验)、成员标识、UI 上报反馈 | A13、A14、A15 |
| M3 可配置调度与设置 | D-12、D-13:设置面板支持时间、API Key、成员、webhook;重写并重载 launchd | A16、A17 |
| M4 安装与升级原子化 | D-3、D-4、D-9 + 隔离安装测试 | A1、A2、A3、A12 |
| M5 UI 可验收与可追溯 | D-15、D-6、UI 冒烟脚本、诊断面板 | A8、A10、NFR-9 |
| M6 团队上线 | D-14、FR-14:安装说明、隐私披露、3–10 人灰度 | A11、NFR-13 |
| 后续 | **D-25 app bundle 公证与 staple**、Windows 对等(FR-10)、历史/周报、本地脱敏规则 | — |

## 10. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **所有成员会话摘录发送到公网 LLM 端点,且本期不做本地脱敏** | 团队代码/业务信息外发,可能违反合规要求 | 已在 Q8 确认为接受项;建议尽快评估「本地关键词排除规则」作为后续 P1,并在成员须知中显式披露 |
| 飞书 webhook token 泄露(每个成员机器上都有一份) | 任何人都能向群内发消息 | token 存 `.env`(0600);启用飞书签名校验(FR-7.4);必要时轮换 |
| 日报发到共享群造成信息过载 | 团队成员忽略消息 | 消息内容控量(FR-7.6);约定发送时间;必要时改为卡片折叠明细 |
| 用户机器为自签/企业代理证书环境 | LLM 请求失败(已实际发生:`debug.log` 三次 `CERTIFICATE_VERIFY_FAILED`) | 已加载系统 CA(`:37-43`);需持续验证打包后行为 |
| LLM 输出漂移 | 排除选择丢失、日报口径不一致 | 稳定 id(D-7)+ 标题相似度匹配 |
| 分发仓库为个人账号 | 团队依赖个人仓库,人员变动即风险 | 团队扩大或稳定运行后迁移到组织仓库 |
| 双架构构建漂移 | 发布资产不一致 | CI 矩阵 + 发布审计 |
| 单文件引擎持续膨胀 | 可维护性下降 | 需要时拆分为模块,协议保持不变 |

## 11. 关键事实记录(代码证据)

1. 引擎为单文件 214 行 Python,无第三方依赖(`daily_agent_digest.py`)。
2. 唯一自动化测试为 `tests/test_core.py` 中 1 个用例,当前通过。
3. 本地安装目录存在残留临时文件 `.daily-agent-digest-macos-arm64.73331`、`.SHA256SUMS.73331`,印证 D-4。
4. `~/.local/share/daily-agent-digest/state.json` 中 `release_version` 为 `v0.4.11`(由托盘环境注入),而 `run.sh` 未导出该变量。
5. 公共分发仓库最新 release 为 `v0.4.11`,包含全部 6 个预期资产(引擎 2 + app zip 2 + `install.sh` + `SHA256SUMS`)。
6. Windows 客户端源码共 9 行,仅能弹出原始 JSON;Windows CI job 只做编译断言。
7. 正式版(`v0.4.11`)已在本机停止:两个 launchd 服务 `bootout` + `disable`,托盘进程已退出,安装文件与 `.env` 未修改。本地开发改用源码开发版(`scripts/dev.sh`,隔离在 `.dev/`),详见 `docs/development.md`。
8. 实测(`.dev` 开发环境 + 真实 LLM 端点):同样输入下 LLM 返回的 `source_task_ids` 为 `codex/default`、`deepseek-harness/default`,而真实 session id 形如 `01a09339-...`、`dsh-...` —— 印证 D-18。
9. **v0.5.0 已发布**(2026-09-13,提交 `ae281b1`):CI 三个 job 全绿(含新增 UI 冒烟测试),公共资产 6 个齐全,`scripts/release-audit.sh` 手动运行通过(4 个文件 SHA256 全部 OK),实测发布二进制包含本次修复(报告无 `summary` 字段、未配置通道时 `submit_status=not_configured`)。
10. `scripts/release-audit.sh` 仍未接入 CI(D-9),本次为手动执行;本机 `sha256sum` 存在,但 macOS 原生只有 `shasum`,接入 CI 时需注意。
11. 实测(2026-09-13,真实 `$HOME`):当天 281–331 条事件中,`codex` 的 `functionCallOutput`+`commandExecution`+`mcpToolCall` 占 77k 字符,`dsh` 的 `assistant/message` 占 152k 字符;修复前只有 34 条进入模型且全部来自 codex,修复后为 158 条(codex 32 + dsh 126),日报从"3 项自动化"变为"5 项真实工作"。
12. 开发版默认从 fixture 采集(`.dev/source`),要看真实数据必须 `./scripts/dev.sh app --real` 或 `generate --live --real`;这正是"今日 0 条"的直接原因(当日 fixture 无数据)。

## 12. 已确认决策记录

| 编号 | 问题 | 决策 | 影响 |
| --- | --- | --- | --- |
| Q1 | 目标用户与分发范围 | **团队内部使用**(3–10 人) | 引入成员标识、共享群上报、团队安装说明;不做服务端 |
| Q2 | 本期平台范围 | **只做 macOS**,Windows 标记为后续 | FR-10 降为 P2;Windows CI 仅保持编译绿 |
| Q3 | 日报上报目标 | **飞书自定义机器人(群 webhook)** | 新增 FR-7 全节、D-10;`DIGEST_SUBMIT_URL` 被取代 |
| Q4 | 采集数据源 | **保持 Codex / Pi / DeepSeek Harness 三源** | FR-1.4 冻结;采集器仅做健壮性补强 |
| Q5 | 调度时间 | **时区保持 UTC+8,时间在设置界面可配置** | FR-8.3 升级为 P0(需重写并重载 launchd) |
| Q6 | 文档定位 | **取代 production-delivery-plan,作为新需求基线** | 旧计划归档为历史参考 |
| Q7 | 历史与周期报表 | **只要当天** | 非目标 N4;不做历史 UI 与周报 |
| Q8 | 隐私与凭据 | **托盘设置内可更换 API Key**(未选本地脱敏、未选强制确认) | FR-11.4 升为 P0;脱敏风险记入第 10 章 |
| Q9 | 具体 IM 通道 | **飞书自定义机器人** | 按飞书 payload 与 `code == 0` 语义实现 |
| Q10 | 上报身份标识 | **需要,使用姓名/工号** | 新增 `DIGEST_MEMBER` 与 `member` 字段 |
| Q11 | LLM 接入方式 | **每人自己的 key 直连公网** | 不做团队网关;安装/设置需自助填 key |
| Q12 | 分发渠道 | **继续使用现有公共 GitHub release** | 仅需补充团队安装说明 |
| Q13 | 团队规模 | **3–10 人,全 macOS,各自本地运行** | 无服务端;私有仓库迁移风险记入第 10 章 |
| Q14 | 1000 字的口径 | **摘要 + 所有标题 + 所有正文** | FR-3.11 按此计算 `report_chars` |
| Q15 | 项多时如何取舍 | **压缩每项字数,保持全部工作项**(不删项) | `fit_report` 按项数均分预算,20 项也全部保留 |
| Q17 | 「工作总结」的结构 | **每一项一个标题+内容,LLM 直接产出 `{title, desc}` JSON;排除 = 删除数组元素** | 取消自由叙述与 `summary` 字段;排除不再需要 LLM(见 D-24) |
| Q16 | 「工作总结」显示什么 | **把摘要扩展成完整总结(报告主体),工作项只保留标题、不要正文** | 摘要预算从 150 字放开到 600–900 字;`work_items` 不再有 `details`;界面改为总结区自适应高度 + 标题列表 |

### 12.1 遗留小项(不阻塞开工,实现前确认即可)

1. 飞书消息形态:纯文本 `text` 还是交互卡片 `interactive`(卡片更清晰但需维护卡片结构)。
2. 是否用 `<at user_id="all">所有人</at>` 通知全群(自定义机器人无法 @ 指定人)。
3. 群机器人是否启用「签名校验」与关键词/IP 白名单(影响 FR-7.4 与团队配置文档)。
4. Windows 对等的目标时间点。
