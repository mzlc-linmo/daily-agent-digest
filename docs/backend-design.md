# 后端设计:日报提交服务 + 飞书多维表格

日期:2026-09-13
状态:**已确认**(决策见第 12 节)

## 1. 目标

- 每台机器上的 App 只需配置**一个 API 地址 + 一个 API Key**,就能把当天的日报提交出去。
- 提交结果落到**飞书多维表格**,团队在那里查看、筛选、统计。
- 不把任何飞书应用密钥放进客户端。
- **不再向群里发消息**(决策 Q19):多维表格成为唯一的日报收口。

## 2. 为什么必须有后端

飞书多维表格的写入接口需要 `tenant_access_token`,它由**应用 App ID + App Secret** 换取。若让客户端直接写表,只有两种可能:

1. 把 App Secret 打进安装包 → 任何人反编译即可读写整张表,不可接受;
2. 每人自建一个飞书应用 → 3–10 人规模下管理成本高于收益。

因此:**凭据只留在服务端,客户端只持有一把可撤销的 API Key**。后端顺带承担幂等、校验、覆盖与审计。

## 3. 架构(Serverless,无数据库)

```
┌────────────┐  HTTPS  POST /api/v1/digests
│  App       │  Authorization: Bearer <member key>
│ (每台机器) │  Idempotency-Key: member:date:sha256
└────────────┘ ─────────────────────────────┐
      ▲                                     ▼
      │ 201 {record_ids}        ┌──────────────────────────────┐
      └──────────────────────── │  云函数(单函数,Python)     │
                                │  ① 校验 Key → 成员身份       │
                                │  ② 校验载荷                  │
                                │  ③ 按 提交ID 查表(幂等/覆盖)│
                                │  ④ batch_update / _create    │
                                └───────────────┬──────────────┘
                                                │ tenant_access_token(模块级缓存)
                                                ▼
                                    ┌────────────────────────┐
                                    │ 飞书多维表格(状态即数据)│
                                    │ 表1 日报明细(一行一项) │
                                    └────────────────────────┘
```

**关键设计:多维表格自己就是状态存储。**

Serverless 没有本地库,而"同一天覆盖旧行"需要知道旧行的 `record_id`。解决方式是把 `提交ID = {member_id}-{date}` 作为表内字段,提交时先按它查表:

- 查不到 → `batch_create`
- 查到 N 行 → `batch_update`(按序覆盖)+ 若本次工作项变少,`batch_delete` 多余的行

这样**不需要任何数据库**,也不需要 KV;代价是每次提交多一次查表调用(约 100–200ms,量级完全可接受)。

## 4. 接口契约

### 4.1 提交日报

```
POST /api/v1/digests
Authorization: Bearer <member-api-key>
Content-Type: application/json
Idempotency-Key: <date>:<content_sha256>   # 客户端追踪用;服务端幂等由"已认证成员 + 日期"推导
```

```json
{
  "date": "2026-09-13",
  "generated_at": "2026-09-13T18:02:08+08:00",
  "release_version": "v0.5.1",
  "report_chars": 832,
  "coverage_note": "当天入库 66 条(提示词 11 / 最终文本 53 / 交付物 2);送模型 62 条 / 14,662 字符",
  "work_items": [
    { "title": "报告窗口正文渲染修复", "desc": "…", "status": "completed",
      "source_task_ids": ["codex/01a0…", "deepseek-harness/…"] }
  ]
}
```

**请求体里没有成员字段**:成员身份一律由 API Key 推导,客户端传什么都不采信,避免冒名。

响应:

```json
{ "submission_id": "sub_01J…", "member": "张三", "date": "2026-09-13",
  "mode": "created|updated|unchanged",
  "records": [{"index": 0, "record_id": "rec…"}],
  "submitted_at": "2026-09-13T18:02:11+08:00" }
```

- `created` 首次;`updated` 同一天内容变化后覆盖;`unchanged` 内容完全相同(幂等命中,HTTP 200,不写表)。

### 4.2 错误语义

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 401 | `invalid_key` | Key 不存在或被撤销 |
| 403 | `member_disabled` | 成员被停用 |
| 422 | `validation_failed` | 字段缺失 / `work_items` 为空 / 超长 |
| 429 | `rate_limited` | 超过每 Key 限额(建议 10 次/分钟) |
| 502 | `bitable_unavailable` | 飞书写入失败(含 `code != 0`),附飞书 `log_id` |
| 503 | `not_ready` | 拿不到 `tenant_access_token` |

**硬约束**(与需求 FR-7.2/7.7 一致):只要表格没写成功就必须返回非 2xx,客户端**绝不能标记为已上报**。飞书接口常在 HTTP 200 下返回 `code != 0`,必须解析响应体判断。

### 4.3 其它接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/me` | 用 Key 换取成员信息(姓名/工号),供「设置」保存时校验并回填显示名 |
| `GET /api/v1/digests?date=` | 查询某天是否已提交,客户端可显示"本周已提交 N 天" |
| `GET /healthz` | 存活 + 飞书 token 可用性 |

## 5. 鉴权与密钥管理

**核心模型:Key 就是人员身份的载体。**

```
管理员在后端签发 Key
        │  ① 指定人员(工号 + 姓名),并确定其飞书 open_id
        │  ② 生成随机 secret,只把 sha256 存进 KV
        ▼
   Key 记录 = { hash, member, member_id, open_id, enabled, created_at }
        │  ③ 明文 Key 只返回一次,交给该成员
        ▼
成员在 App 里填「提交地址 + Key」→ 提交时服务端由此确定身份
```

- **签发时就绑定人员**,包括 `open_id`。提交时直接取用,**不再每次去解析邮箱**——身份不会漂移,也不依赖提交时的通讯录调用。
- `open_id` 的确定方式(二选一):
  - 直接给 `open_id`(推荐:从企业已有表格的人员字段读取,或由管理员提供);
  - 给 `email` 由服务端调 `contact/v3/users/batch_get_id` 解析 —— 这需要应用开通 **`contact:user.id:readonly`** 并重新发布。
  - 两者都拿不到就**拒绝签发**,不生成一把无法关联通讯录的 Key。
- 存储:**Workers KV**(键 `key:<key_id>`),无数据库;鉴权时按 `key_id` 直接读,边缘缓存,延迟可忽略。
- 服务端**只存 `sha256(secret)`**,恒定时比较;明文只在签发响应里返回一次。
- **撤销**:把 `enabled` 置为 false(保留记录便于审计),**下一次请求立即失效**;也可以按需删除记录。
- 客户端把 Key 存在 `.env`(权限 `0600`),设置界面只写不回显(沿用 FR-11.3)。

### 5.1 空值/异常的处理口径

| 情况 | 行为 |
| --- | --- |
| Key 不存在或格式错误 | `401 invalid_key` |
| Key 已撤销 | `403 key_revoked` |
| Key 未绑定 `open_id`(只可能来自手工塞进旧 `API_KEYS` 变量的条目) | 提交照常成功,「成员」列留空,响应里 `member_linked: false`,并写日志 —— 宁可空一列,也不丢一天的日报 |

## 6. 多维表格设计

### 6.1 表1:日报明细(一行一个工作项,已确认 Q22)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 提交ID | 文本 | `{member_id}-{date}`;幂等与覆盖的检索键 |
| 日期 | 日期 | 建议作为排序主字段 |
| 成员 | **人员(关联飞书通讯录,type=11)** | 由 Key 推导后写入 `[{"id": "<open_id>"}]`;需要应用具备 `contact:user.id:readonly` 才能把邮箱解析成 open_id。解析不到时该列留空,但提交照常成功 |
| 标题 | 文本 | 工作项标题 |
| 内容 | 多行文本 | 工作项正文 |
| 状态 | 单选 | `completed` / `in_progress` / `blocked` |
| 字数 | 数字 | 该项 title+desc 字数 |
| 来源 | 多选 | `codex` / `pi` / `deepseek-harness` |
| 提交时间 | 日期时间 | 服务端收到时间 |
| 应用版本 | 文本 | 便于排查旧版本 |

`提交ID` 建议加**索引/分组**,便于人工核对;仪表盘按「成员」「日期」分组即可看到谁交了、交了几项。

### 6.2 飞书侧准备步骤

1. 开发者后台创建**自建应用**,开通 `bitable:app`(读写多维表格);若「成员」列要关联通讯录,还需开通 **`contact:user.id:readonly`**(把邮箱解析成 open_id)。
2. 把应用添加为目标多维表格的**协作者**(或在文档「…」→ 添加文档应用),否则写表报权限错误。
3. **发布应用版本**(权限变更需重新发布才生效)。
4. 记录 `app_token`(URL 中 `/base/` 之后那段)与 `table_id`(`?table=` 参数),写进函数环境变量。

## 7. 函数实现要点

- **token 缓存**:`tenant_access_token` 约 2 小时有效。存在**模块级变量**里(热实例复用),提前 5 分钟视为过期;遇 401 / `99991663` 强制刷新一次再重试。冷启动重新获取,约 +200ms。
- **读**:`GET /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records?filter=CurrentValue.[提交ID]="{id}"`(分页,取全部匹配行)。
- **写**:`batch_create` / `batch_update`(按 `record_id`)/ `batch_delete`(工作项变少时);单批 ≤ 500 行。
- **顺序**:先查表 → 决定 created/updated/unchanged → 写表成功后才返回 2xx。函数超时设为 ≥30s;所有飞书调用 10s 超时。
- **重试**:仅网络错误与 5xx 退避重试(最多 3 次);业务 `code != 0` 不重试,直接 502 并回传 `log_id`。
- **日志**:只记 `submission_id` / `member` / `date` / 条数 / 耗时 / 飞书 `log_id`,**不记日报正文**。
- **规模**:单函数、纯 `urllib` 或 `httpx`,无重依赖;冷启动可控。

## 8. 客户端改动(很小)

引擎的 `submit()` 已经在向 `DIGEST_SUBMIT_URL` POST `{date, work_items}`,因此:

1. 载荷扩展为第 4.1 节字段(补 `generated_at` / `release_version` / `report_chars` / `coverage_note`,以及每项 `status`、`source_task_ids`);
2. 新增请求头 `Idempotency-Key = date:content_sha256`(客户端只知道日期与内容指纹;服务端用"已认证成员 + 日期"做幂等,不依赖该头);
3. 设置项:`DIGEST_FEISHU_WEBHOOK` **移除**,改为 `DIGEST_SUBMIT_URL` + `DIGEST_API_KEY`;成员只需填这两项(已确认 Q23),姓名由服务端回填显示;
4. 保存设置时调用 `GET /api/v1/me` 校验 Key;
6. 沿用 D-1:非 2xx 或响应判定失败 → `submit_status=failed`,绝不显示"已上报"。

## 9. 安全、隐私与运维

- **只允许 HTTPS**;HTTP 直接拒绝,避免 Key 明文过网。
- App Secret 只存函数环境变量;不进日志、不进仓库。
- **隐私披露(重要)**:日报正文会经服务端中转并**长期保存在团队共享的表格里**。现状是内容不出本机、只发一条群消息——这是本次架构变更带来的最大差别,必须写进成员须知(需求 FR-14.4)。
- 建议按季度归档/清理旧数据,或只保留最近 N 个月。
- 每 Key 限流(10 次/分钟);可选校验提交日期窗口(当天 ±1 天),防止补交历史污染看板。

## 10. 测试与验收

- **契约测试**:本地 mock 飞书,覆盖 `created/updated/unchanged/401/422/429/502`。
- **幂等与覆盖**:同日同内容二次提交 → `unchanged` 不写表;内容变化 → `updated` 且**行数不变**;工作项减少 → 多余行被删除。
- **失败语义**:飞书 `code != 0` 时客户端 `report_status` 不得为 `submitted`。
- **端到端**:对沙箱多维表格真写一次,确认字段映射与仪表盘可用。

## 11. 里程碑

| 阶段 | 内容 | 出口 |
| --- | --- | --- |
| M1 表与权限 | 建表、建应用、加协作者、发布版本 | 用调试台能写入一行 |
| M2 函数 | 鉴权 + 幂等 + 覆盖 + 错误语义 | 契约测试全绿 |
| M3 客户端 | 设置项改地址+Key、载荷扩展、`/me` 校验 | 真机提交成功且表格出现记录 |
| M4 团队上线 | 签发 Key、成员须知(含隐私披露)、看板 | 3–10 人各提交一次 |

## 12. 运行在 Cloudflare Workers(已确认 Q20 细化)

**技术上可行**,但有几处必须注意:

| 项 | 说明 |
| --- | --- |
| 运行时 | Workers 跑 JS/TS(V8 isolate),**不是 Python**。这是一个独立的小服务(约 200 行 TS + wrangler 配置),与 Python 引擎解耦,只共享接口契约。 |
| 密钥 | `wrangler secret put FEISHU_APP_SECRET` → 运行时 `env.FEISHU_APP_SECRET`。**密钥不进代码、不进仓库**,只在 Cloudflare 侧保存。App ID / app_token / table_id 属于非敏感项,可放 `vars`。 |
| token 缓存 | `tenant_access_token` 存在**模块级变量**(热 isolate 复用),冷启动重新获取。Workers 的 isolate 会被回收且可能并存多份,所以缓存是"尽力而为"——3–10 人的量级下,即便每次都重新取 token 也远低于飞书 1000 次/分钟的限额。如需强一致,可加 **Workers KV** 存 token(可选升级)。 |
| CPU 时间 | 免费版 10ms **CPU** 时间/请求(等待 fetch 不计入),本项目只做几次 I/O + 少量 JSON,通常够用;若冷启动 + 加密开销触发超限,升到付费版(默认 30s CPU)即可。 |
| 子请求数 | 一次提交约 3–5 次 fetch(取 token + 查表 + 写入/更新),免费版 50 个子请求上限绰绰有余。 |
| HTTPS | `*.workers.dev` 默认就是 HTTPS,无需证书配置。 |
| 日志 | `wrangler tail` 实时查看;**不记录日报正文**。 |
| 无数据库 | 与本设计一致:表内 `提交ID` 即状态存储,Workers 不需要 KV/DB。 |

### 12.1 中国大陆可达性(必须实测)

`*.workers.dev` 在中国大陆**经常不稳定或不可访问**。若团队成员在内地:

1. 先实测:`curl -sS -o /dev/null -w '%{http_code}' https://<你的>.workers.dev/healthz`(用成员所在网络);
2. 不可达时的选项:① 换国内云函数(腾讯云函数 / 阿里云函数计算,同一套接口契约与表结构,只需换运行时适配层);② 用自定义域名接入 Cloudflare(仍需确认所在网络可达性,且大陆加速需企业套餐与备案域名)。
3. 接口契约、表结构与客户端都**与运行时无关**,因此即便先上 Workers 再迁回国内,客户端无需改动。

## 13. 客户端凭据的保存(已确认 Q23 细化)

**只配置一次,之后一直复用**,不存在"每次都要输入":

| 环节 | 行为 |
| --- | --- |
| 存储位置 | `~/.local/share/daily-agent-digest/.env`,新增 `DIGEST_SUBMIT_URL` 与 `DIGEST_API_KEY`,文件权限 `0600`(与现有 `LLM_*` 同文件) |
| 录入方式 | 托盘菜单 →「设置」新增两个输入框:提交地址、API Key(密码样式);保存后写入 `.env` |
| 不重复输入 | 引擎每次启动 `load_env()` 读取;定时任务、托盘生成、重启后都直接复用 |
| 不回显 | `settings` 命令只返回 `submit_url` 与 `api_key_set: true/false`,**绝不回显 Key 明文**(沿用 FR-11.3);设置界面显示「已配置」而不是明文 |
| 校验 | 保存时调用 `GET /api/v1/me`,成功则把服务端返回的成员名显示出来(用于确认 Key 归属正确),失败则提示且不保存 |
| 团队批量下发 | 支持用环境变量 `DIGEST_SUBMIT_URL` / `DIGEST_API_KEY` 非交互传入,便于统一部署;未设置时走设置面板手工填一次 |
| 轮换 | 服务端撤销旧 Key → 成员在设置面板粘贴新 Key 保存即可,无需重装 |

## 14. 需要提供/确认的信息

| 项 | 谁提供 | 说明 |
| --- | --- | --- |
| `app_token`(多维表格 base ID) | 你 | URL `/base/<app_token>?table=<table_id>` 中 `/base/` 之后那段 |
| `table_id` | 你 | 上面 URL 的 `?table=` 参数;若希望我建新表,可暂不提供 |
| App ID | 你 | `cli_xxx`,非敏感 |
| **App Secret** | **只写进 Cloudflare Secret,不要发给我** | 它是全表读写凭据,贴进对话即等于泄露 |
| 应用是否已加为该表的协作者 | 你确认 | 仅"有 bitable 权限"不够,必须把应用加进这张表(或所在 base)的协作者,否则写表报权限错误 |
| 应用是否已发布 | 你确认 | 权限变更后必须重新发布版本才生效 |
| 表结构 | 二选一 | ① 你给已有表的字段名;② **我提供 bootstrap 接口,自动建表 + 建字段并返回 `table_id`**(推荐,避免手工建错类型) |

## 15. 实现状态(2026-09-13)

| 部分 | 状态 | 位置 |
| --- | --- | --- |
| Worker:路由 / 鉴权 / 校验 / 幂等覆盖 / 错误语义 / bootstrap | **已实现** | `workers/src/*.js` |
| Worker 单测(12 项:created·updated·unchanged·鉴权·校验·502) | **通过** | `workers/test/handler.test.js`(`npm test`,零依赖) |
| 部署配置与操作说明 | **已就绪** | `workers/wrangler.toml`、`workers/README.md` |
| 客户端:设置项(提交地址 + API Key,保存一次长期复用) | **已实现** | `daily_agent_digest.py` 的 `settings`/`save_settings`,`DailyAgentDigest.swift` 设置面板 |
| 客户端:提交载荷 + `Idempotency-Key` + 失败语义 | **已实现** | `daily_agent_digest.py` 的 `submit()` |
| 客户端:Key 校验与姓名回填(`check-submit` → `GET /api/v1/me`) | **已实现** | 同上 + 设置面板「测试连接」 |
| 端到端(引擎 → 假服务) | **已验证** | 请求头、载荷字段、只上报未排除项、`check-submit` 回填成员 |
| 真实飞书表格写入 | **已验证** | 独立 base「团队日报」/ 表「日报明细」已建,今日 6 项真实工作已写入 |

尚未完成:Cloudflare 侧的实际部署与 bootstrap(需要你的 `app_token`);`GET /api/v1/digests?date=` 目前只被测试覆盖,客户端暂未使用。

## 16. 部署与验证记录(2026-09-13)

| 项 | 值 |
| --- | --- |
| Worker 地址 | `https://daily-agent-digest-submit.mzlc.workers.dev` |
| 多维表格 | base「团队日报」`JHoFbrmTBaTN8nsmoYScZyTpnEb`,表「日报明细」`tbl77oxPmPcVVyVz` |
| 飞书应用 | `cli_aa13a11707b89bdb`(凭据存于本机钥匙串 `zentao.mzlc.me`) |
| secrets | `FEISHU_APP_SECRET`、`ADMIN_TOKEN`(已写入 Cloudflare) |
| D1 | `daily-agent-digest-logs`(`audit_log` 表):提交(含失败)、签发、撤销、bootstrap 全部留痕,默认保留 180 天 |
| 管理 CLI | `workers/scripts/digest-admin.mjs`:不带参数进入**管理台**(列出全部管理项按编号选择);子命令 menu / install / status / feishu / deploy / tables / employees / issue / keys / revoke / logs |
| KV | `KEYS` 命名空间 `6f1b2801ee524cd7a3dab047e5c7e1a8`,存放成员 Key |
| Key 生命周期 | **线上已验证**:签发 → 用 Key 调 `/api/v1/me` 成功 → 列表不含哈希 → 撤销后立即 `403 key_revoked` |
| 自动签发 | Worker `scheduled()` 每分钟轮询申请表:未签发的行自动生成 Key 并把明文写回该行;状态改为「已撤销」即停用。**成员填表 ≈1 分钟后就拿到 Key,无需管理员介入** |
| 成员↔Key 映射 | 飞书两张表:「成员密钥」(台账,自动写入)与「密钥申请」(表单申请,签发后自动关单);权威仍在 KV |
| 申请表单 | `https://kcnld55n87yl.feishu.cn/share/base/shrcngFJnMSxeEn760KVmhEiDve`(管理字段已隐藏) |
| 端到端 | **已完成**:本地 App → 线上 Worker → 飞书表格,今日 6 项工作的「成员」列显示 **Master Cui**(已关联通讯录) |
| 客户端 UA | Cloudflare 会拦截 `Python-urllib`(403 / error code 1010),引擎已固定发送 `DailyAgentDigest/<版本>`;自研客户端必须带 UA |
| open_id 获取 | **不需要新权限**:从企业已有表格的人员字段(「负责人」等)即可取到本应用可用的 open_id,实测写入「日报明细」的成员列成功(`code=0`) |
| 已核验 | `/healthz` ok;bootstrap 幂等;鉴权边界(无 Key/错 Key → 401、未知路径 → 404);`created → unchanged → updated → unchanged` 且同日行数恒为 1;真实写入 6 行 |
| 待办 | 应用需开通 `contact:user.id:readonly` 并重新发布,「成员」列才会关联到通讯录 |

## 17. 踩过的两个飞书限制(已规避)

1. **人员字段不能作主字段** —— 建表时用人员字段当第一列会报 `1254012 Unsupported field type`;申请表的主字段因此是文本「申请标题」。
2. **人员字段不能用 filter 匹配** —— `CurrentValue.[申请人]="ou_…"` 与 `.contains("ou_…")` 实测都命中 0;改为按状态取回、在服务端本地比对人员。

另外两条运维经验:`wrangler secret put` 后新值有几秒传播延迟,紧接着调用管理接口会拿到 401;KV 的 `list` 是最终一致的,刚签发完可能查不到,以 `get` 为准。

## 18. 简化:Key 由表单自动产出(2026-09-13 调整)

原设计是"成员填表 → 管理员签发"。实际用起来管理员那一步是多余的负担,因此改为:

- Worker 加 **Cron 触发**(`* * * * *`),`scheduled()` 轮询「密钥申请」表;
- 未签发的行 → 生成随机 Key,存 KV(只存哈希),**把明文写回该行的「Key」列**并置状态为已签发;
- 状态改为「已撤销」的行 → 停用对应 Key 并更新台账;
- 管理员接口(`/admin/keys`)保留,用于批量签发、排障与人工撤销 —— 它同时会关掉该成员待处理的申请,避免与定时任务重复签发。

**踩到的坑**:表单把「状态」设为隐藏字段,成员提交后该列是**空的**,而定时任务原本只在 `状态=待处理` 时签发,
导致真实提交永远拿不到 Key(用真实表单验证时才发现)。现在**空状态同样视为待处理**,并补了回归测试。

**权限模型(2026-09-13 收紧)**:

- 表单**只保留「申请人」一个字段**(人员字段设为 `property.multiple=false`,**单选**,一次只能选一人);
  成员提交后看不到任何结果页面以外的内容;定时任务只在**恰好选了一人**时才签发,多选一律跳过(不猜身份);
- base 的**链接分享已关闭**,协作者只有「应用」与「管理员本人」→ **Key 只有管理员能看到**;
- 管理员把 Key 复制并发给成员,**这个手动动作就是审核**,系统内没有审批流;
- **一人一把有效 Key**:重新申请时旧 Key 立即失效(台账保留撤销记录),避免凭证越积越多。

风险提示:若将来要把该 base 分享给团队看日报,必须先把两张 Key 表拆到独立 base,
或开启 Bitable 高级权限限制可见范围 —— 否则 Key 会随 base 一起暴露。

**踩到的第三个飞书坑**:表单字段"先设必填、再隐藏"会留下**隐藏但必填**的状态,提交必被拦住;
已隐藏的字段又无法直接改 `required`(报 `1254001`)。正确顺序是**先取消必填、再隐藏**。

## 19. 审计日志与运维入口(2026-09-14)

**日志入 D1**:此前"提交失败"只留在 Workers Logs(保留数天,不可查询)。现在每次提交都往 D1 的
`audit_log` 写一行,成功与失败都写,并带上 `mode`/`items`/`duration_ms`/`error_code`/`user_agent`/`country`;
签发、撤销、bootstrap 也写。写入是 best-effort —— 日志服务故障绝不能影响成员提交日报。

**管理 CLI**:`workers/scripts/digest-admin.mjs` 把"装后端 → 配飞书 key → 配管理员口令 → 建表回填 table id →
读员工 → 选人生成 Key"串成一条流程,每步也可单独重跑。安全细节:

- App Secret 与管理员口令只经 stdin 交给 `wrangler secret put`,不落盘、不打印;可从本机钥匙串复用;
- `admin-token --local-only` 只把口令存本机(**不覆盖** Cloudflare 上的口令);
- `--yes` 非交互模式下,若本机已有口令则**拒绝改动** Cloudflare 的 secret —— 避免自动化把线上口令冲掉。

## 20. 移除公网管理接口(2026-09-14)

原先 `/admin/bootstrap`、`/admin/keys`、`/admin/keys/revoke`、`/admin/logs` 都在公网上,
靠一个共享的 `ADMIN_TOKEN` 保护。这是最弱的一环:**口令一旦泄露(截图、终端历史、日志、误贴),
任何人都能签发 Key、读取全部审计日志**,而且它是单一因素。

现在**彻底删除这些接口**,管理动作全部在**本机**完成:

| 动作 | 原来 | 现在 |
| --- | --- | --- |
| 建表/建字段 | `POST /admin/bootstrap` | CLI 直连飞书 API(复用 `src/tables.js`) |
| 签发 Key | `POST /admin/keys` | CLI 直连 KV(`wrangler kv`)+ 写台账 + 写 D1 |
| 撤销 | `POST /admin/keys/revoke` | 同上 |
| 查日志 | `GET /admin/logs` | CLI 直连 D1(`wrangler d1 execute`) |

**门槛变成**:一台已登录 Cloudflare 的机器 + 本机飞书 App Secret。CLI 的每个管理命令都先 `wrangler whoami`,
未登录直接拒绝。Worker 公网只剩 `/healthz`、`/api/v1/me`、`/api/v1/digests`。

**关键约束:规则只存在一处。** CLI 不复制任何逻辑 —— 直接 import Worker 的 `src/keys.js`、`src/registry.js`、
`src/tables.js`、`src/logs.js`,只有传输层不同(wrangler 适配器 vs Worker binding)。
`scripts/local-admin.mjs` 把这些封成一层,并有单元测试覆盖(含"一人一把"、只存 sha256、SQL 转义)。

**代价(必须记住)**:Cloudflare 账号权限远大于"只能发 Key 的口令"。因此
**不要把 Cloudflare 账号访问权给非管理员**;若将来需要第二个人管 Key,应给范围更窄的凭据
(例如只能读写该 KV 的 Cloudflare API Token),而不是账号权限。

**安全性收益**:公网上不再存在任何管理入口,"猜口令/爆破/口令泄露"这一整类风险消失;
同时少了一个需要轮换的长期 secret(`ADMIN_TOKEN` 已不再需要)。

## 21. 取消飞书侧的 Key 登记与自助申请(2026-09-14)

在管理台能"列出员工 + 一键签发/轮换/撤销"之后,飞书侧那两张表就成了负担:

- **「密钥申请」表 + 表单**:成员自助申请 → 定时任务自动签发。但这套流程要求成员会找表单、
  要求管理员事后核对,而自动签发的 Key 明文会落在表里(靠 base 权限兜底),收益不抵复杂度;
- **「成员密钥」登记表**:信息与 D1 审计日志重复。

因此**两张表已删除,填表申请流程取消**:

| 能力 | 现在由谁承担 |
| --- | --- |
| 签发 / 轮换 / 撤销 | 管理台「员工与 Key」(本机 CLI,直连 KV) |
| 台账 / 审计 | **D1 `audit_log`**(`issue_key` / `revoke_key` / `submit`,含失败) |
| 成员自助申请 | 取消:成员向管理员索取,管理员在管理台一键签发 |

飞书 base 里**只剩「日报明细」一张表**;定时任务只剩"每小时清理过期日志"。
迁移前两张表的数据已备份到本机 `.dev/backup/feishu-admin-tables.json`。

## 22. 已确认决策

| 编号 | 问题 | 决策 |
| --- | --- | --- |
| Q19 | 提交目标 | **只写多维表格**(取代原群自定义机器人方案 Q3) |
| Q20 | 部署位置 | **云函数 / Serverless**;因此不引入数据库,表本身作为状态存储 |
| Q21 | 同日重新提交 | **覆盖旧行**;内容完全相同则幂等返回,不写表 |
| Q22 | 表结构 | **一行一个工作项** |
| Q23 | 客户端配置 | **只需 API 地址 + API Key**;姓名由服务端回填 |
