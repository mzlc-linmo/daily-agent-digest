# 日报提交服务(Cloudflare Worker)

接收 App 提交的日报,写入**飞书多维表格**。设计见 `docs/backend-design.md`。

```
App ──POST /api/v1/digests──▶ Worker ──tenant_access_token──▶ 飞书多维表格
      Authorization: Bearer dag_<key_id>_<secret>
```

## 前置(飞书侧)

1. 开发者后台的自建应用开通 **`bitable:app`**(读写多维表格)权限。
2. **把应用添加为目标多维表格的协作者**(文档右上「…」→ 添加文档应用)。只开权限不加协作者,写表会报权限错误。
3. **发布应用版本**(权限或协作者变更后必须重新发布才生效)。
4. 记下多维表格 URL 里的两个 ID:

```
https://xxx.feishu.cn/base/<BITABLE_APP_TOKEN>?table=<BITABLE_TABLE_ID>
```

## 管理台(推荐入口)

在终端里直接运行,**不带参数就进管理台**:

```bash
cd workers
node scripts/digest-admin.mjs
```

**启动时会自动检查 Cloudflare 登录状态**:未登录就先拉起 `wrangler login`(会打开浏览器),
登录成功后自动回到脚本,不用手动先跑一遍。

**用 ↑/↓ 选择、Enter 确认、q 退出**(非终端场景自动退回"输入编号",脚本仍可用):

```
日报上报后端 · 管理台

  ── 初次安装 ──
  ❯ 一键全流程(校验凭据 → 部署 → 建表 → 员工与 Key)
  ── 配置与部署 ──
    查看状态(配置 / Cloudflare 登录 / 后端健康)
    配置飞书应用凭据(App ID / Secret)
    创建 KV / D1 并部署 Worker
    建飞书表并回填 table id(只建「日报明细」)
  ── 成员与 Key ──
    员工与 Key(列出 / 签发 / 轮换 / 撤销)
  ── 审计日志 ──
    查看最近日志
    按条件查日志(成员 / 日期 / 成功失败)
```

### 「员工与 Key」一个入口管到底

列出所有员工并带上 Key 状态,**没 Key 的只显示名字**:

```
  ── 员工与 Key(共 23 人)──
❯ 成员甲            未签发
  成员乙            已签发  7c1f9a02
  示例成员      已签发  14a59ada
  张三            有 Key 但不在员工名单  aaaaaaaa
```

```
  ── 员工与 Key(共 23 人)──
❯ 成员甲            已签发  dag_1f7a783f_********
  示例成员      已签发  dag_14a59ada_********DjvU
  成员乙            未签发
```

列表里只显示**掩码**:前缀(`dag_<key_id>_`)与**末 4 位**可见,中间是星号。完整密钥**只在签发那一刻显示一次**,
之后无法从服务端还原 —— 服务端只保存 `sha256` 和这 4 个字符,两者都拼不出密钥。成员弄丢就选「轮换」。

签发时同时给出**本人要对接的提交地址**,否则对方只拿到一串 Key 也不知道往哪提交:

```
✓ 「成员甲」的 Key(只显示这一次):
    dag_1f7a783f_****************************************
    提交地址:https://daily-agent-digest-submit.<你的子域>.workers.dev
    本人把「提交地址」和这串 Key 填进托盘菜单「设置」,先点「测试连接」确认识别到本人,再点「保存」。
    请立即发给本人;丢失在「员工与 Key」里轮换。
```

地址取部署时写回本地配置的 `SUBMIT_URL`(可用环境变量 `DIGEST_SUBMIT_URL` 覆盖)。模板里的
`SUBMIT_URL` 是 `YOUR_SUBDOMAIN` 这类**占位符**,会被当作"没有地址":此时签发只给一句可操作的提示,
不会把占位符当真实地址发出去 —— 先跑 `deploy`(或 `adopt`)拿到真实地址再来签发。

选中后按状态给出不同操作:

| 选中的人 | 提示 |
| --- | --- |
| 没有 Key | 是否**签发**?答是 → 生成,明文显示一次,请立即发给本人 |
| 已有 Key | **查看掩码** / **轮换**(签发新 Key,旧的立即失效)/ **撤销** / 取消 |
| 有 Key 但不在员工名单 | 是否撤销其 Key |

### 向导会显示已配置的值

`一键全流程` 里每一步先打印当前配置,已配置的**默认跳过**(回车即可),

```
▶ 创建 KV/D1 并部署后端 —— 已配置
    当前值:KV 6f1b2801…;D1 daily-agent-digest-logs;地址 https://….workers.dev
? 已配置,是否重新执行? [y/N]:
```

### 配置:模板入库,真实值只在本地

仓库里跟踪的是**模板** `workers/wrangler.toml.example`;`workers/wrangler.toml` 是**你自己的配置文件,已被
`.gitignore` 忽略**。`deploy` / `tables` / `adopt` 写进去的真实值(token、表 id、KV/D1 id、Worker 子域)因此
**永远不会出现在 `git status` 里,也不会被提交**。`git checkout` / 重新 clone 不会再冲掉它们。

- 本地配置不存在时,任何命令都会自动从模板创建一份并提示(新机器第一步无需手动 `cp`);
- `status` 会打印实际用的配置文件以及它是否被 git 跟踪(万一被跟踪会直接标红);
- 模板里的值仍是占位符(`bascnREPLACE_WITH_YOUR_BASE_TOKEN`、`YOUR_SUBDOMAIN`…),`status` 会把它们显示成
  「未配置 / 占位符(需填真实 id)」并整体告警 —— 这是提醒,不是 CLI 坏了;
- **占位符状态下不要跑 `deploy` / `tables`**:那会把占位符写进线上 Worker,直接打断所有人上报。命令本身也会拦住你
  (KV/D1 是占位符时明确失败,而不是新建命名空间 —— 新建会丢掉已签发的 Key)。

换机器或配置丢失后,一条命令就能恢复:

```bash
node workers/scripts/digest-admin.mjs adopt
```

它先从 Cloudflare 按名字找回 KV `KEYS` 与 D1 `daily-agent-digest-logs`,然后**只问一条飞书多维表格链接** ——
`app_token` 和 `table_id` 本来就在同一条地址栏 URL 里,不该让人分两次回答:

```
  ── 飞书多维表格 ──
     在飞书里打开那张日报表,把地址栏整条粘进来即可(两种写法都认):
       https://<租户>.feishu.cn/base/<app_token>?table=<table_id>
       https://<租户>.feishu.cn/wiki/<node_token>   (知识库里的表,会自动换算)
✓ 解析到 app_token = JHoFbrmTBaTN8nsmoYScZyTpnEb
✓ 飞书校验通过:该 base 下有 2 张表(日报明细、成员)
✓ 按表名「日报明细」补上 table_id = tblAbCdEf123
```

细节:

- 链接里带了 `?table=` 就直接用;**没带**就调飞书接口按 `BITABLE_TABLE_NAME`(默认「日报明细」)自动定位并回填;
- 粘完之后会用飞书接口**校验**一次:token 粘错、表 id 不属于该 base、应用没有该表的权限,都会当场报出来,
  而不是等到跑 `tables` / `employees` 时才失败;
- 知识库(`/wiki/…`)链接给的是 `node_token`,会调用 `wiki/v2/spaces/get_node` 换算成真正的 `app_token`
  (需要本机有飞书 App ID / Secret);
- KV / D1 若按名字找不到,会**列出账号里现有的名字**,便于用 `--kv-id` / `--d1-id` 指定。

| 缺失项 | 取回方式 |
| --- | --- |
| KV 命名空间 id | **`adopt` 自动**(`npx wrangler kv namespace list` 里 `KEYS` 那条);找不到时用 `--kv-id` |
| D1 `database_id` | **`adopt` 自动**(`npx wrangler d1 list`);找不到时用 `--d1-id` |
| 飞书主表 token / 表 ID | **`adopt` 只问一条链接**:飞书里打开那张表,地址栏 `/base/<app_token>?table=<table_id>` 整条粘进去 |
| 飞书 App ID(`FEISHU_APP_ID`) | 飞书开放平台 → 开发者后台 → 该应用 → 凭证与基础信息 → App ID |
| 后端地址 `SUBMIT_URL` | 打开托盘菜单「设置」,『提交地址』那一栏里就是它 |
| 本地飞书 App Secret | 只用于 CLI 直连飞书:飞书开放平台同一页的 App Secret;写入本机钥匙串 `security add-generic-password -s daily-agent-digest -a feishu-app-secret -w`(或每次加 `--app-secret`)。线上那一份是 Cloudflare secret,读不回明文,也**不需要**重建 |

> **不要**指望从 Cloudflare 控制台的 Worker 变量里找回旧值 —— 那里看不到部署时写入的明文(token 只存服务端,
> 且部署后不保证在界面上可读)。要恢复配置,上面这几条才是可靠路径。

## 子命令(等价能力)

```bash
node scripts/digest-admin.mjs install        # 全流程引导
```

向导依次完成:**校验飞书凭据 → 创建 KV/D1 并部署 Worker → 建飞书表并回填 table id → 读取员工 → 选员工签发 Key**。
每一步也可以单独重跑(幂等)。

| 命令 | 作用 |
| --- | --- |
| `digest-admin.mjs status` | 显示配置、Cloudflare 登录状态、后端健康(默认命令) |
| `digest-admin.mjs feishu` | 配置并**校验**飞书 App ID / Secret |
| `digest-admin.mjs deploy` | 创建 **KV**(存 Key)+ **D1**(存审计日志)、应用 `schema.sql`、部署 Worker |
| `digest-admin.mjs tables` | 建「日报明细」表 → **回填 table id** → 重新部署 |
| `digest-admin.mjs members` | **员工与 Key 合并视图**(列出 / 签发 / 轮换 / 撤销) |
| `digest-admin.mjs employees` | 只列出员工(含 open_id 与来源) |
| `digest-admin.mjs issue` | 直接签发(`--open-id/--email/--name/--member-id` 可非交互) |
| `digest-admin.mjs keys` / `revoke <key_id>` | 列出 / 撤销 |
| `digest-admin.mjs logs` | 查询审计日志(`--member --date --event --outcome --limit`) |

### 安全模型(重要)

**Worker 上不存在任何管理接口**,公网只有三个成员接口:`/healthz`、`/api/v1/me`、`/api/v1/digests`。
建表、发 Key、撤销、查日志**全部在本机执行**,直连 KV / D1 / 飞书。

因此**没有管理员口令**,门槛是两样东西:

1. 一台**已登录 Cloudflare** 的机器(`wrangler login` 或 `CLOUDFLARE_API_TOKEN`)—— 每个管理命令都会先检查;
2. 本机钥匙串里的**飞书 App Secret**。

> ⚠️ **代价**:Cloudflare 账号权限远大于"只能发 Key 的口令"(能操作账号下所有 Worker/KV/D1/secret)。
> 所以**不要把 Cloudflare 账号访问权给非管理员**。若将来需要第二个人管理 Key,
> 应当给他一个范围更窄的凭据(例如只能读写该 KV 的 Cloudflare API Token),而不是账号权限。

### 可选环境变量

| 变量 | 说明 |
| --- | --- |
| `WRANGLER_CMD` | 默认 `npx --yes wrangler` |
| `CLOUDFLARE_API_TOKEN` | 免交互登录(CI 或不想用 OAuth 时) |
| `DIGEST_SCAN_BASES` | 额外扫描的 base(`token:名称`);默认读 `wrangler.toml` 的 `SCAN_BASES` |

## 飞书侧只有一张表

base「团队日报」里**只有「日报明细」**一张表:每个工作项一行,写的是谁、哪天、做了什么、多少字、来源与内容指纹。

> 2026-09-14 调整:原先的「成员密钥」登记表与「密钥申请」表已删除,成员自助填表申请 Key 的流程一并取消。
> 现在 **Key 只由管理员用本机 CLI 签发**,台账由 **D1 的审计日志**承担(谁在什么时候签发了/撤销了哪把 Key)。

## 管理员签发 Key(本机执行)

```bash
node scripts/digest-admin.mjs employees      # 先看有哪些人(含 open_id)
node scripts/digest-admin.mjs issue          # 交互式:选序号(可多选)→ 逐个签发

# 或直接指定
node scripts/digest-admin.mjs issue --open-id ou_xxxx --name 张三 --member-id zhangsan
```

用的是与 Worker **同一批模块**(`src/keys.js` / `src/registry.js`),所以"只存 sha256"、
"一人一把有效 Key"这些规则与本机、服务端完全一致,不存在两份实现。

明文 Key 只在签发时显示一次;台账里只有公开的 key_id。

## 成员侧配置

管理员签发 Key 后,把 **提交地址 + Key** 交给成员,成员在 App 的「设置」面板填一次即可(保存在本机 `0600` 的
`.env` 里,后续自动复用):

```
提交地址  https://<你的>.workers.dev
API Key  dag_xxxxxxxx_yyyyyyyy…
```

## 接口(只有成员接口)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| GET | `/api/v1/me` | 用 Key 换回成员身份(App「测试连接」用) |
| GET | `/api/v1/digests?date=` | 查询某天是否已提交 |
| POST | `/api/v1/digests` | 提交日报(幂等:同日同成员覆盖) |

`/admin/*` 已彻底移除;管理动作见上面的 CLI。

## 定时任务

`scheduled()` 每小时第 0 分钟清理一次过期审计日志(默认保留 180 天)。签发已取消自动流程,不再轮询飞书表。

## 本地开发与测试

```bash
npm test          # 无依赖单测:用假飞书客户端覆盖 created/updated/unchanged/鉴权/校验/502
npx wrangler dev  # 本地起服务;密钥放 .dev.vars(已 gitignore)
```

`.dev.vars` 示例:

```
FEISHU_APP_SECRET="..."
ADMIN_TOKEN="dev-admin"
```

## 排错

| 现象 | 原因 |
| --- | --- |
| `91402` / 权限不足 | 应用没被加为该多维表格的协作者,或权限变更后没重新发布版本 |
| `not_ready` / 503 | App ID / Secret 不对,或 `FEISHU_APP_SECRET` 没设置 |
| 成员报 `invalid_key` | Key 拼错,或该 Key 已被撤销(`403 key_revoked`) |
| 签发时报「无法解析为 open_id」 | 应用未开通 `contact:user.id:readonly`,或邮箱不属于本企业;改为直接给 `open_id` |
| 提交成功但「成员」列空白 | 该 Key 记录缺 `open_id`(手工塞进旧 `API_KEYS` 变量的条目会这样),重新用 `/admin/keys` 签发 |
| 申请填了但一直「待处理」 | 申请人是人员字段,服务端无法用 filter 匹配人员,因此按状态取回后在本地比对;确认申请表里的「申请人」确实选中了本人 |
| 建表报 `Unsupported field type` | 飞书不允许用人员字段作**主字段**,申请表的主字段因此是文本「申请标题」 |
| 表单提交报错/收不到记录 | 检查表单里有没有「隐藏但必填」的字段:改必填必须**先取消必填再隐藏**(隐藏状态下改 required 会报 `1254001`),否则提交会被必填校验拦住 |
| 日报表里「成员ID」是 `u…` | 表单只收集「申请人」,`账号` 留空时用 open_id 后 6 位兜底 |
| 客户端报 `HTTP 403 error code: 1010` | Cloudflare 拦截了默认的 `Python-urllib` User-Agent;引擎已固定带 `DailyAgentDigest/<版本>` 标识,自研客户端也必须带 UA |
| 大陆网络访问超时 | `*.workers.dev` 不可达,见设计文档 12.1;可迁到国内云函数,客户端无需改动 |

## 审计日志(D1 持久化)

**每次提交都会落一行**(成功与失败都写),签发/撤销/建表也记录在案,存在 **D1** 的 `audit_log` 表里:

| 列 | 说明 |
| --- | --- |
| `ts` / `event` | 时间;`submit` / `issue_key` / `revoke_key` / `bootstrap` |
| `key_id` / `member` / `member_id` | 由哪把 Key、哪位成员发起 |
| `date` / `mode` / `items` / `report_chars` | 日报日期、`created`/`updated`/`unchanged`、条数、字数 |
| `duration_ms` / `outcome` / `error_code` / `error_message` | 耗时与结果(失败原因) |
| `release_version` / `user_agent` / `country` | 客户端版本、UA、来源国家 |

```bash
node scripts/digest-admin.mjs logs --limit 50            # 最近 50 条
node scripts/digest-admin.mjs logs --member zhangsan --date 2026-09-13
node scripts/digest-admin.mjs logs --outcome error       # 只看失败
```

直接查库(不经后端):

```bash
npx wrangler d1 execute daily-agent-digest-logs --remote \
  --command "SELECT ts, event, outcome, member_id, error_code FROM audit_log ORDER BY id DESC LIMIT 20"
```

日志写入是 **best-effort**:D1 出问题不会影响日报提交(有测试覆盖)。定时任务每小时清理一次,
默认保留 **180 天**(`logs.js` 的 `pruneLogs`)。

