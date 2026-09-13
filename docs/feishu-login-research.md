# 调研:App 能否通过飞书账户登录

日期:2026-09-13
结论:**技术上可行,但对当前已确认的需求不是必要路径**;若要走,必须先做一次开发者后台可行性验证,见第 4 节。

## 1. 为什么会有这个需求

当前设计里"谁提交了日报"是靠**手工配置的成员名**(决策 Q10),而群里的消息统一由一个共享的群自定义机器人发出,发送者都显示为同一个机器人。如果能用飞书账户登录,可以顺带解决两件事:

1. 身份自动获取,不用手填姓名/工号;
2. 消息**以本人身份**发出,群内天然区分谁发的那份日报。

## 2. 官方能力(证据)

### 2.1 登录:授权码流程 + PKCE 可用

飞书开放平台提供标准 OAuth 2.0 授权码流程:

- 授权页:`GET https://accounts.feishu.cn/open-apis/authen/v1/authorize`,参数 `client_id`(App ID)、`response_type=code`、`redirect_uri`、`scope`、`state`。
- **支持 PKCE**:`code_challenge` + `code_challenge_method=S256`,配合 v2 token 端点换取 token。这意味着**公开客户端(桌面应用)不必内嵌 client_secret**。
- token 端点:`POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`;`user_access_token` 有效期约 2 小时,`refresh_token` 约 7 天(需 `offline_access` scope)。
- 用户授予的权限是**累积**的,scope 需在开发者后台预先申请开通,否则授权页报 20027。

来源:[获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code)、[浏览器网页接入指南](https://open.feishu.cn/document/sso/web-application-end-user-consent/guide)

### 2.2 回调地址必须预先登记

> 只有配置在应用重定向 URL 列表内的网页地址可以通过安全校验;不在列表内会跳转到失败页并报 `2000 redirect_uri unmatch`。

配置位置:开发者后台 → 应用详情 → **安全设置** → 重定向 URL(单个应用最多 300 个)。文档中的示例一律是 `https://example.com/...`。

来源:[配置重定向 URL](https://open.feishu.cn/document/uYjL24iN/uYjN3QjL2YzN04iN2cDN)

### 2.3 以用户身份发消息:可行,但与群自定义机器人是两条路

`POST https://open.feishu.cn/open-apis/im/v1/messages`:

- `Authorization` 接受 `tenant_access_token` **或** `user_access_token`;响应体 `sender.sender_type` 可为 `user` 或 `app`。
- **用户身份发消息**需同时具备 `im:message` 与 `im:message.send_as_user` 两个权限。
- 关键限制:**该接口仅支持开发者后台创建的应用机器人调用,群自定义机器人无法调用该接口**;且机器人必须**在该群内且有发言权限**(否则 230002 / 230018)。
- 群内机器人共享 **5 QPS** 限频。

来源:[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)

## 3. 对当前架构的影响

| 方面 | 现状(群自定义机器人 webhook) | 改为飞书登录 + 应用机器人 |
| --- | --- | --- |
| 建群内机器人 | 任何群成员可自建自定义机器人,无需管理员 | 需在开发者后台创建**自建应用**,由企业管理员审批并发布,再把应用机器人拉进群 |
| 身份来源 | 手工填写成员名(`DIGEST_MEMBER`) | 授权后自动获得(可读姓名 / user_id / open_id) |
| 消息发送者 | 统一显示为同一个机器人 | 可显示为**本人**(`im:message.send_as_user`) |
| 凭据 | 一个 webhook token(可选签名密钥) | 每个成员一份 `user_access_token` + `refresh_token`,需定期刷新 |
| 失败模式 | 网络 / token 失效 | 另加:授权过期、权限被回收、管理员改可用范围、应用未发布 |
| 服务端 | 无 | 仍然无(纯客户端 PKCE 可行),但需要一个可登记的回调地址 |

**注意**:两条通道不能混用——一旦要以用户身份发送,就必须放弃群自定义机器人 webhook,改用应用机器人与 `im/v1/messages`。

## 4. 必须先验证的关键未知点

文档没有给出**本机 loopback 回调**的先例(示例均为 https 域名)。桌面应用要拿到 `code`,常见做法是本地起一个临时 HTTP 服务并把 `http://127.0.0.1:<port>/callback` 登记为回调地址,但**飞书是否接受这种地址,文档未说明**。

建议先做一次 30 分钟的后台验证(不改代码):

1. 创建一个测试自建应用,尝试把 `http://127.0.0.1:8765/callback` 加入**安全设置 → 重定向 URL**:能否保存?
2. 若被拒,测试自定义 scheme(如 `daily-agent-digest://oauth/callback`)是否可登记;
3. 申请 `im:message` + `im:message.send_as_user`,用 PKCE 走一遍授权,确认**不传 client_secret** 也能换到 token;
4. 把应用机器人拉进测试群,发一条消息,确认 `sender.sender_type == user`(即群里显示为本人)。

任一步不成立,方案就要调整(例如改为登记一个团队可控的静态回调页,由用户复制 code 回填——多一步手工操作)。

## 5. 替代方案(无需登录)

| 方案 | 身份来源 | 群内区分发送者 | 需要管理员 | 工作量 |
| --- | --- | --- | --- | --- |
| A. 现状:共享自定义机器人 + 正文标注成员名 | 手工配置 | 否(消息里写名字) | 否 | 已完成设计 |
| B. **每人各自建一个自定义机器人**(以本人命名),各填各的 webhook | 机器人名即身份 | **是**(显示为不同机器人) | 否 | 仅配置,零代码 |
| C. 飞书登录 + 应用机器人以用户身份发送 | 自动 | 是 | **是** | 中(授权 + token 刷新 + 通道迁移) |

## 6. 建议

对已确认的范围(3–10 人、全 macOS、各自本地、无服务端),**方案 B 已能满足"谁提交的"这一诉求,代价接近零**;方案 C 的额外价值只有"消息确实以本人身份发出"。

因此在决定投入之前,建议按顺序:

1. 先确认真正想解决的问题是"身份标注"还是"发送者必须是本人";
2. 若是前者 → 用方案 B(每人一个自定义机器人,名字用自己的姓名),无需登录;
3. 若是后者 → 先做第 4 节的可行性验证,再评估方案 C 的落地成本(管理员审批 + token 生命周期 + 通道迁移)。

## 7. 与「后端 + 多维表格」方案的关系

若采纳 `docs/backend-design.md` 的提交服务,登录问题基本被绕开:后端持飞书应用密钥写多维表格,**成员身份由 API Key 推导**,不再需要 OAuth,也不需要"以本人身份发消息"。只有在既要求"群里以本人身份出现"、又要求"写入多维表格"时,才需要两者都做。

## 8. 待决策

| 编号 | 问题 | 选项 |
| --- | --- | --- |
| Q18 | 飞书登录要解决的是身份标注还是发送者身份? | A 身份标注(用方案 B)/ B 发送者必须是本人(走方案 C) |
| Q19 | 是否先做开发者后台可行性验证? | A 做(约 30 分钟,不改代码)/ B 暂不投入 |
