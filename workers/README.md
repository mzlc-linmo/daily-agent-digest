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

## 一键部署:管理 CLI

所有运维动作都在一个 CLI 里,每一步都可以单独重跑(幂等);首次使用直接跑向导:

```bash
cd workers
node scripts/digest-admin.mjs install
```

向导依次完成:**配置飞书凭据 → 配置管理员口令 → 创建 KV/D1 并部署 → 建飞书表并回填 table id → 读取员工 → 选员工签发 Key**。

也可以逐步执行:

| 命令 | 作用 |
| --- | --- |
| `digest-admin.mjs status` | 显示当前配置缺什么、后端是否健康 |
| `digest-admin.mjs feishu` | 配置并**校验**飞书 App ID / Secret(Secret 只经 stdin 交给 wrangler,不落盘) |
| `digest-admin.mjs admin-token` | 配置管理员口令;`--local-only` 只存本机钥匙串、不覆盖 Cloudflare |
| `digest-admin.mjs deploy` | 创建 **KV**(存 Key)+ **D1**(存审计日志)、应用 `schema.sql`、部署 Worker |
| `digest-admin.mjs tables` | 调 `/admin/bootstrap` 建表建字段 → **回填 table id** → 重新部署 → 配置申请表单 |
| `digest-admin.mjs employees` | 读取员工(含 open_id) |
| `digest-admin.mjs issue` | 交互式选员工签发 Key(或 `--open-id --name --member-id`) |
| `digest-admin.mjs keys` / `revoke <key_id>` | 列出 / 撤销 |
| `digest-admin.mjs logs` | 查询审计日志(`--member --date --event --outcome --limit`) |

密钥来源:飞书 App Secret 与管理员口令优先从**本机钥匙串**读(`service=daily-agent-digest`),
其次读环境变量;因此配好一次之后,后续命令都不用再输入。

手动等价命令(不想用 CLI 时):

```bash
npx wrangler secret put FEISHU_APP_SECRET   # 提示时粘贴 App Secret
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

### 环境变量(可选)

| 变量 | 说明 |
| --- | --- |
| `WRANGLER_CMD` | 默认 `npx --yes wrangler` |
| `DIGEST_SUBMIT_URL` | 后端地址;默认读 `wrangler.toml` 的 `SUBMIT_URL` |
| `ADMIN_TOKEN` | 管理员口令;默认读钥匙串 |
| `DIGEST_SCAN_BASES` | 额外扫描的 base(`token:名称`,逗号分隔);默认读 `wrangler.toml` 的 `SCAN_BASES` |

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

## 管理员签发 Key

```bash
# 1) 找不到人时先查 open_id(从企业已有表格的人员字段读)
node scripts/digest-admin.mjs employees

# 2) 交互式:列出员工 → 选序号(可多选,如 1,3)→ 逐个签发
node scripts/digest-admin.mjs issue

# 或直接指定
node scripts/digest-admin.mjs issue --open-id ou_xxxx --name 张三 --member-id zhangsan
```

明文 Key 只在签发响应里出现一次;服务端只存 sha256,台账里也只有公开的 key_id。

## 成员侧配置

App 托盘菜单 →「设置」,只填两项:

| 项 | 值 |
| --- | --- |
| 提交地址 | `https://<你的>.workers.dev` |
| API Key | `dag_…` |

保存时会调用 `GET /api/v1/me` 校验,并把服务端返回的**姓名回填显示**,确认 Key 归属正确。凭据写入 `~/.local/share/daily-agent-digest/.env`(权限 `0600`),之后定时任务与重启都自动复用,不需要再输入。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/digests` | 提交日报;同日重复提交按「成员+日期」覆盖,内容相同则幂等返回 |
| GET | `/api/v1/me` | 用 Key 换成员信息(设置校验用) |
| GET | `/api/v1/digests?date=` | 查询某天是否已提交 |
| GET | `/healthz` | 存活 + 能否拿到 tenant_access_token |
| POST | `/admin/bootstrap` | 建表 + 建字段(需 `ADMIN_TOKEN`) |

错误语义见设计文档第 4.2 节。**只要表格没写成功就返回非 2xx**,客户端因此不会误报"已上报"。

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

