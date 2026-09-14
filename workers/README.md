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

**用 ↑/↓ 选择、Enter 确认、q 退出**(非终端场景自动退回"输入编号",脚本仍可用):

```
日报上报后端 · 管理台

  ── 初次安装 ──
  ❯ 一键全流程(校验凭据 → 部署 → 建表 → 员工与 Key)
  ── 配置与部署 ──
    查看状态(配置 / Cloudflare 登录 / 后端健康)
    配置飞书应用凭据(App ID / Secret)
    创建 KV / D1 并部署 Worker
    建飞书表并回填 table id(含配置申请表单)
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
❯ 阿树            未签发
  源源            已签发  7c1f9a02
  Master Cui      已签发  14a59ada
  张三            有 Key 但不在员工名单  aaaaaaaa
```

选中后按状态给出不同操作:

| 选中的人 | 提示 |
| --- | --- |
| 没有 Key | 是否**签发**?答是 → 生成并把明文 Key 显示一次 |
| 已有 Key | **轮换**(签发新 Key,旧的立即失效)/ **撤销** / 取消 |
| 有 Key 但不在员工名单 | 是否撤销其 Key |

### 向导会显示已配置的值

`一键全流程` 里每一步先打印当前配置,已配置的**默认跳过**(回车即可),

```
▶ 创建 KV/D1 并部署后端 —— 已配置
    当前值:KV 6f1b2801…;D1 daily-agent-digest-logs;地址 https://….workers.dev
? 已配置,是否重新执行? [y/N]:
```

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
| `digest-admin.mjs tables` | 建飞书表 → **回填 table id** → 重新部署 → 自动配好申请表单 |
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

## 成员与 Key 的映射:两张飞书表

`/admin/bootstrap` 会自动在同一个 base 里建好这两张表(幂等,已存在就复用):

| 表 | 作用 | 写入方 |
| --- | --- | --- |
| **成员密钥** | 台账:谁有一把 Key、状态、签发/撤销/最近提交时间 | 服务端自动写入(签发/撤销/提交时) |
| **密钥申请** | 成员自助申请(表单只有「申请人」,**单选人员字段**);定时任务自动签发并写回 Key | 成员填表单,服务端回写 Key/状态 |

**权威仍在 KV**:鉴权只读 KV;这两张表是给人和审计看的,best-effort 写入 —— 台账写失败不会影响成员提交日报。

### 成员怎么申请(表单只选人,Key 只给管理员看)

1. 成员打开表单,**只需要选择自己**(表单里只有「申请人」一个字段,且为**单选**,一次只能选一人):
   `https://<你的租户>.feishu.cn/share/base/<form_token>`
2. **约 1 分钟内**,该行的「Key」列自动出现一把随机密钥(每分钟运行的定时任务生成),状态变为 `已签发`。
3. **只有能打开这张表的人(管理员)看得到 Key** —— base 已关闭链接分享,协作者只有应用与管理员本人。
4. 管理员把 Key 复制出来发给该成员;**这一步手动动作就是审核**,系统里没有额外的审批流程。
5. 成员把「提交地址 + Key」填进 App 的「设置」。

`账号` 列在表单里隐藏,留空时 `成员ID` 自动取该成员 open_id 的后 6 位(形如 `u671ef3`)——
稳定且不会重名;想让日报表里显示工号,可让管理员在登记表里改,或改用下面的管理员签发接口。

### 两条硬规则

- **一人一把有效 Key**:同一成员重新申请/重新签发时,旧 Key **立即失效**(台账保留为「已撤销」),
  不会每提交一次就多留一把永久凭证。
- **Key 只落在这张管理员可见的表里**,不写进日报表,也不发给成员以外的人。

> ⚠️ 如果将来要把这个 base 分享给团队看日报,请**先把这两张表拆到另一个 base**,
> 或开启 Bitable 高级权限限制可见范围,否则 Key 会随 base 一起暴露。

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

App 托盘菜单 →「设置」,只填两项:

| 项 | 值 |
| --- | --- |
| 提交地址 | `https://<你的>.workers.dev` |
| API Key | `dag_…` |

保存时会调用 `GET /api/v1/me` 校验,并把服务端返回的**姓名回填显示**,确认 Key 归属正确。凭据写入 `~/.local/share/daily-agent-digest/.env`(权限 `0600`),之后定时任务与重启都自动复用,不需要再输入。

## 接口(只有成员接口)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| GET | `/api/v1/me` | 用 Key 换回成员身份(App「测试连接」用) |
| GET | `/api/v1/digests?date=` | 查询某天是否已提交 |
| POST | `/api/v1/digests` | 提交日报(幂等:同日同成员覆盖) |

`/admin/*` 已彻底移除;管理动作见上面的 CLI。

## 定时任务

`scheduled()` 每分钟运行:轮询「密钥申请」表,给未签发的行生成 Key 并写回该行;
状态为「已撤销」的行则停用对应 Key;每小时清理一次过期审计日志。这部分必须留在服务端,
所以"填表即得 Key"不需要管理员在场。

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

