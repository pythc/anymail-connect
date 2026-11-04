# Google / Outlook 邮箱接入

Google 和微软邮箱已属于原生适配范围。本轮明确范围并补充接入说明，未重复创建适配器或改变已有授权逻辑。

| 账号类型 | 选择的服务商 | 后端 |
| --- | --- | --- |
| Gmail 个人邮箱 | Gmail / Workspace | `gmail`，Gmail API + Google People |
| 启用 Gmail 的 Google Workspace 企业邮箱，包括自定义域名 | Gmail / Workspace | 同上，受 Workspace 管理员策略限制 |
| Outlook.com / Hotmail / Live 个人邮箱 | Outlook / Microsoft 365 | `graph`，Microsoft Graph 用户委派 OAuth |
| Microsoft 365 / Exchange Online 企业邮箱 | Outlook / Microsoft 365 | 同上，受组织同意和条件访问限制 |
| Microsoft 365 委派共享邮箱 | Outlook / Microsoft 365，并填写共享邮箱地址 | `graph` 的指定邮箱路由及 `.Shared` 委派权限 |

Outlook 是客户端名称时，不能据此判断服务商；例如 Outlook 中添加的 QQ 邮箱仍使用对应 IMAP/SMTP 后端。本地 Exchange Server 与 Exchange Online 分开配置，前者见 [EWS 运维说明](operations-0.3.zh-CN.md)。

## 先配置 AnyMail

按 [部署说明](deployment.zh-CN.md) 配置自己的 PostgreSQL、加密密钥、HTTPS `BASE_URL` 和 AnyMail 登录 OIDC。邮箱 OAuth 与 AnyMail 自身登录的 OIDC 是两套配置。

Google 和微软邮箱 OAuth 应用均使用以下精确的服务端回调地址：

```text
https://你的-AnyMail-域名/oauth/provider/callback
```

该值必须等于 `BASE_URL` 加 `/oauth/provider/callback`，不要填 ChatGPT 的 MCP OAuth 回调。邮箱 client secret 仅存服务端配置；不要写入插件包或聊天消息。

## Google Gmail / Workspace

1. 在自己的 Google Cloud 项目启用 Gmail API 和 People API，配置 OAuth 同意信息和适用的用户范围。
2. 创建 Web application OAuth client，将上述精确地址加入 authorized redirect URIs。
3. 设置 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`，重启 AnyMail API。
4. 登录管理页，在“添加邮箱 → 服务商”选择“Gmail / Workspace”，按需要允许写入和发送，再点击“通过服务商授权”。共享邮箱字段留空；本项目不使用 Google 全域委派替代逐用户授权。

当前只读连接申请 `gmail.readonly` 和 `contacts.readonly`；可写连接申请 `gmail.modify` 和 `contacts`。请求离线授权以获取 refresh token。Google 同意页成功仍不等于公共应用审核或企业管理员策略已通过；AnyMail 的发送开关、调用权限及固定内容审批继续独立执行。[Google 服务端 OAuth](https://developers.google.com/workspace/gmail/api/auth/web-server)、[Google Workspace 授权说明](https://developers.google.com/workspace/guides/auth-overview)。

## Outlook.com / Hotmail / Microsoft 365

1. 在自己的 Microsoft Entra 租户注册应用。若同时服务个人与企业账号，选择支持组织账号和个人 Microsoft 账号的类型；仅单租户部署可限制为该组织。
2. 添加 Web 平台及上述精确 redirect URI，创建服务端 client secret，配置对应的 Graph delegated permissions。
3. 设置 `MICROSOFT_CLIENT_ID`、`MICROSOFT_CLIENT_SECRET`。全球云中同时接入个人/企业账号时使用 `MICROSOFT_CLOUD=global`、`MICROSOFT_TENANT=common`；企业专用部署可填写目标 tenant ID。其他云先按 [部署说明](deployment.zh-CN.md) 选择相应云及应用注册。
4. 管理页选择“Outlook / Microsoft 365”。本人邮箱留空共享邮箱字段；企业委派连接填写已有访问权限的共享邮箱地址，再授权。

普通连接请求 `offline_access`、`User.Read`、`Mail.Read` / `Mail.ReadWrite`、`Contacts.Read` / `Contacts.ReadWrite`；开启发送另加 `Mail.Send`。共享连接使用相应 `.Shared` 委派权限。共享权限适用于组织账号，不把个人 Outlook.com 账号当作企业共享邮箱。[微软应用注册/账号类型](https://learn.microsoft.com/en-us/graph/auth-register-app-v2)、[Graph 委派权限](https://learn.microsoft.com/en-us/graph/permissions-reference)。

共享邮箱还需要 Exchange/租户实际授予对应访问和发送权限，OAuth consent 不会自动授予 Send As / Send on Behalf。AnyMail 不提供应用级全域扫描，也不承诺任意别名发件；委派共享邮箱的推送使用周期对账作为替代。

## 已实现与待验收

双方均接入统一 MCP 搜索/查读/附件、应用草稿/回复/转发、可信发送审批和同步工作流，并提供各自原生能力；参见 [能力矩阵](capability-matrix.zh-CN.md)。Gmail / Graph 的原生草稿同步、未知结果停止及附件限制见 [0.3 实现状态](implementation.zh-CN.md)。

已存在 Gmail/Graph HTTP 请求契约、Graph 各云 token 刷新与 OAuth 状态、People 联系人、原生草稿/Bcc/版本控制测试。合成测试不等于已连接真实 Google 或微软账号。本次未获取真实邮箱授权、发送邮件、创建云端 OAuth 应用或完成公共审核；上述真实账号验收继续保留在 TODO。

2026-11-04 本轮重新运行以下相关适配器测试集：26 项通过，0 失败/跳过（测试集也包含 CardDAV/EWS 等边界检查）。

```sh
node --import tsx --test --test-concurrency=1 tests/providers.test.ts tests/provider-environments.test.ts tests/extended-providers.test.ts
```
