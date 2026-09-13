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

## 部署

```bash
cd workers
npm install                     # 只装 wrangler(devDependency,运行时不依赖)

# 密钥(不会进代码仓库)
npx wrangler secret put FEISHU_APP_SECRET     # 飞书应用的 App Secret
npx wrangler secret put ADMIN_TOKEN           # 自己定的管理口令,仅用于 bootstrap

# 非敏感配置写进 wrangler.toml 的 [vars]
#   BITABLE_APP_TOKEN / FEISHU_APP_ID

npx wrangler deploy
```

部署后会得到 `https://daily-agent-digest-submit.<account>.workers.dev`。

### 建表与建字段(bootstrap)

不用手工建字段 —— 调一次 bootstrap 即可,它会按 `docs/backend-design.md` 第 6.1 节的字段定义建表并补全字段:

```bash
curl -sS -X POST https://<你的>.workers.dev/admin/bootstrap \
  -H "Authorization: Bearer $ADMIN_TOKEN" | tee /tmp/bootstrap.json

# 返回里的 table_id 填进 wrangler.toml 的 BITABLE_TABLE_ID,然后重新 deploy
```

bootstrap 是幂等的:表已存在就复用,字段已存在就跳过,只补齐缺失的。

## 签发成员 Key(后端签发,签发即绑定人员)

Key 由**后端**签发,签发时就把人员身份(工号、姓名、飞书 open_id)绑定进去;
提交时服务端直接按 Key 确定身份,不再解析邮箱。

```bash
# 需要 KV:首次部署前执行一次
npx wrangler kv namespace create KEYS      # 把输出的 id 填进 wrangler.toml

# 签发(open_id 优先;也可给 email 让服务端解析,后者需要 contact:user.id:readonly)
curl -sS -X POST https://<你的>.workers.dev/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"member_id":"zhangsan","member":"张三","open_id":"ou_xxxxxxxx"}'
```

返回里的 `key`(`dag_<key_id>_<secret>`)只出现这一次,交给该成员填进 App;服务端只保存哈希。

```bash
# 列出(不含哈希)
curl -sS https://<你的>.workers.dev/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN"

# 撤销:下一次请求立即失效
curl -sS -X POST https://<你的>.workers.dev/admin/keys/revoke \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key_id":"<key_id>"}'
```

**怎么拿到 open_id**:最常见的是从企业已有表格的人员字段直接读(例如排期表的「负责人」),
读到的 open_id 由同一个应用写入本表即可用;或者给 `email`,由服务端解析。
两者都没有会被**拒绝签发**,避免生成一把无法关联通讯录的 Key。

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
| 大陆网络访问超时 | `*.workers.dev` 不可达,见设计文档 12.1;可迁到国内云函数,客户端无需改动 |

## 日志

`npx wrangler tail` 实时查看。只记录 `submission_id`、成员、日期、条数、耗时与飞书 `log_id`,**不记录日报正文**。
