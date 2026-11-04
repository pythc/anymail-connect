# 自托管、身份与运维

当前 0.3 部署还须遵循 [EWS/共享权限/introspection/保留/密钥轮换与 schema v3 步骤](operations-0.3.zh-CN.md)。下文 0.2 的 schema v2 段落是历史版本门槛；当前库为 v3，不可据此回退至旧程序。

## 本地验证

需要 Node.js 24+、npm、OpenSSL；容器部署另需 Docker。所有默认测试均为合成资料，不访问真实邮箱。

```sh
npm ci
npm run check
npm run build
npm run format:check
npm audit --omit=dev --audit-level=high
```

默认测试数据库为 PGlite。要验证真实 PostgreSQL，创建独立本机 `anymail_test` 数据库并设置 `TEST_DATABASE_URL` 后运行同一命令。测试只在该数据库创建随机 `test_*` schema 并在结束删除；不要使用生产数据库。

浏览器检查需要 Python Playwright 与 Chromium：

```sh
python3 -m pip install -r tests/requirements-browser.txt
python3 -m playwright install chromium
npm run test:browser
```

测试器自行启停仅绑定 127.0.0.1:4379 的夹具。可用 `BROWSER_PYTHON` 指定虚拟环境 Python、`CHROMIUM_PATH` 指定本机 Chromium。`.artifacts/browser-session.json` 是合成会话，不可用于部署。

完整 OIDC 实验使用实际 Keycloak 26.8.1、模板生成的合成 realm，监听两个本机端口：

```sh
node tests/oidc-realm.mjs
docker run -d --name anymail-connect-test-keycloak --memory=1g --user=0 \
  -p 127.0.0.1:4391:8080 -v "$PWD/.artifacts/oidc:/opt/keycloak/data/import:ro" \
  quay.io/keycloak/keycloak@sha256:3f3c5f8e03c614774b4bd9173b88391fefa4153bfc010d8012d59ad825377332 \
  start-dev --hostname=http://localhost:4391 --import-realm
npm run test:oidc
docker rm -f anymail-connect-test-keycloak
```

此 realm 含明确命名的测试身份和测试口令，`start-dev`/root 只用于本机隔离实验。部署仅使用 `deploy/` 的无默认用户模板，不使用 `tests/` 入口。CI 分别运行 PGlite、PostgreSQL、浏览器和该 OIDC 实验。

## 配置身份服务

使用已有 OIDC 服务，或在你自己的 Keycloak 中导入 `deploy/keycloak-realm.template.json` 渲染后的 realm：

1. 确定 MCP 公共 HTTPS origin、OIDC issuer 和 ChatGPT 连接页面给出的**精确**回调 URI。
2. 在安全环境设置 `BASE_URL`、`OIDC_CLIENT_SECRET`、`ANYMAIL_TENANT_ID`、`CHATGPT_REDIRECT_URI`，运行 `node scripts/render-config.mjs`；渲染文件包含客户端密钥，保存在忽略目录 `.artifacts`，不可提交。
3. 按 Keycloak 自身的导入/升级流程导入；创建用户、密码/MFA 和企业策略。模板不包含默认用户或默认密码；本机 Keycloak 26.8.1 授权码登录已验证，部署方仍需验收自己的 IdP/MFA/企业策略。
4. `anymail-web` 为网页 confidential client，`anymail-chatgpt` 为预注册 public client，启用 PKCE S256，禁止密码授权。若另一个 MCP 客户端接入，管理员须单独注册并配置精确回调，再加入允许列表。
5. access token 必须带不可由用户修改的 `tenant_id`、`sub`、`azp`/`client_id`、`scope`，audience 必须等于 `BASE_URL/mcp`。issuer 必须与发现文档和 token 完全一致；生产 JWKS 与 issuer 必须同源。模板显式映射 access token 的 `sub`，避免依赖 realm 默认 basic scope；应用不请求未使用的 profile scope。
6. `mail.read`、`mail.write`、`mail.send` 分开授予。模板是单 realm 固定租户；多租户托管需由可信管理员映射租户，不能接受用户填写的 tenant claim。

参考：[OpenAI OAuth](https://developers.openai.com/plugins/build/auth)、[Keycloak OIDC](https://www.keycloak.org/securing-apps/oidc-layers)、[Keycloak realm import](https://www.keycloak.org/server/importExport)。

## 启动服务

复制 `.env.example` 为 `.env`，逐项配置。`node scripts/secrets.mjs` 可生成独立随机值；将输出保存在自己的安全环境中，不贴进聊天或公开工单。数据库密码示例约定使用 hex，若自行使用特殊字符，DATABASE_URL 内必须 URL 编码。

```sh
docker compose build
docker compose up -d
```

API 只映射到宿主 127.0.0.1:3000。配置 HTTPS 反向代理并保留原 Host；不启用无条件 trustProxy。容器内外必须均能解析/访问配置的 OIDC issuer，证书链须有效。`/healthz` 是进程存活检查，不代表邮箱授权、身份服务或投递健康。

打开 `BASE_URL`，登录并连接邮箱。授权码仅在连接表单输入。Gmail/Microsoft 应用注册回调为 `BASE_URL/oauth/provider/callback`，其 clientId/secret 配置在服务端环境变量。只读连接申请读取权限；写入/发信和 Graph 联系人授权按选择增加。发送需要同时允许写入草稿与发信。

内网/Proton Bridge 使用管理员配置的 `PRIVATE_ENDPOINTS` 精确 `host:port` allowlist，并配置可信 CA。该选项不是“关闭 TLS 校验”；不支持无 TLS 密码传输。IMAP 有别名认证名时分别填写 email 与 username；发件身份固定为连接时配置的 email；IMAP 登录仅证明能访问该邮箱，并不独立证明 From 所有权，SMTP 服务商仍须校验发件权限。Gmail/Graph 使用原生账号或委派身份校验，任意 Send As 尚未开放。

邮箱 HTTP API 与服务商 OAuth 可以设置管理员专用的 `OUTBOUND_PROXY_URL=http://proxy.example:3128`，支持 HTTP/HTTPS CONNECT 代理及 URL 内代理认证。默认直连；IMAP/SMTP、OIDC 和宿主文件下载不使用此选项。容器中的 `localhost` 指容器本身；Docker Desktop 访问宿主现有代理可使用 `host.docker.internal`，前提是该代理接受容器连接。只配置受信任代理，凭证放入私有环境文件。每次请求仍先检查目的地主机、全部 DNS 地址和端口，再将已批准的 IP 交给 CONNECT（优先 IPv4，不自动切换地址），保留原 Host、TLS SNI 与证书验证；代理必须支持 IP 目的地隧道。不会自动跟随重定向或在失败时降级直连。代理配置不会自动授权任何私有目标。

## MCP 与插件包

MCP 地址为 `BASE_URL/mcp`，发现文档为 `BASE_URL/.well-known/oauth-protected-resource`。在 ChatGPT 的自定义 MCP 连接中选择预注册 OAuth client，使用 `anymail-chatgpt`、PKCE、token endpoint auth method `none`；回调 URI 从目标连接页面复制，不使用通配符。

复制 `plugin/mcp.template.json` 为包根 `mcp.json`，替换部署 URL，与 `plugin/plugin.json` 一起打包。不要把邮箱密码、OAuth secret、access token 或固定 Authorization header 放进包。模板尚未提交目录审核，插件包不等于公开可安装产品。

## 备份、升级与回滚

- 备份 PostgreSQL 和**独立保存的加密密钥**；丢失密钥后凭证不可恢复。0.3 的轮换必须按独立运维步骤先配置同一密钥环，再执行 dry-run/apply；不要直接移除旧密钥后重启。
- 升级前停止 worker 领取新任务，等待正在提交的操作结束；记录 unknown 操作并人工对账。备份须在隔离数据库演练恢复。
- 0.2.0 增加 schema v2 持久同步队列及索引；v1 邮件/凭证/发送表保留，迁移在事务内可重跑。旧版 0.1.0 发现 v2 会拒绝启动，避免误用主权云凭证；新程序发现更高 schema_version 同样拒绝启动，防止静默不兼容回滚。未来迁移遵循 expand/contract，不能仅靠当前建表脚本宣称后续版本已可回滚。
- 本轮新增发送绑定字段；升级后旧格式 pending/approved 意图会拒绝提交，需取消后重新准备并确认。不可把旧批准默认解释为新格式批准。
- 回滚不得清空 operations 表、重建发送意图或把 unknown 改回 approved。回滚到兼容镜像，保留同一台账与密钥。
- 撤销账号连接清除凭证、缓存与草稿，取消 pending/approved；已开始提交的邮件不能保证撤回。审计与 operations 保留发送证据，备份中的旧数据按部署方保留策略清理。
- 日志只写操作状态，不记录邮件正文和凭证。更细致告警、保留清理和生产容量目标由试点测量后确定。

未在此任务中部署到公网、申请审核或接入个人真实邮箱。

## 0.2.0 即时同步与云环境

`IMAP_IDLE_CONNECTIONS` 默认每 worker 8 条，0 关闭监听。每账号 INBOX 通过数据库租约避免多个 worker 重复占用，连接每 20 分钟轮转；服务器缺少 IDLE 或连接失败时保留周期对账。初始化含 DNS/握手/认证的总期限为 15 秒，取消信号覆盖初始化阶段。事件用固定 500ms 窗口合并，每账号最多一笔入队写入在途，期间新事件保留一次后续信号。断连/停机时尚未落库的防抖信号由重连首次入队和周期对账补偿。网页和 `notifications_status` 显示账号推送状态/worker 分配；worker 租约不代表已完成远端 TLS 握手，也不意味着 ChatGPT 会被主动唤醒。

Graph 云环境在注册应用前选择：`MICROSOFT_CLOUD=global|usgov|usgovdod|china`。OAuth 授权、token 交换/刷新和 Graph API 使用对应静态端点；旧凭证省略 cloud 时使用 global。个人 Outlook 账号使用 global，其他云需要对应组织的应用注册、权限和真实账号验收。Graph 委派共享邮箱不能订阅该共享文件夹推送，继续周期对账。[官方云端点](https://learn.microsoft.com/en-us/graph/deployments)、[Outlook 通知权限限制](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview)。

Gmail 推送由部署方先在 **OAuth 应用同一 Google 项目** 创建 Pub/Sub topic 和 authenticated push subscription：

1. 给 `gmail-api-push@system.gserviceaccount.com` topic Publisher 权限。
2. push endpoint 和 OIDC audience 均为 `BASE_URL/webhooks/gmail`；选择部署方控制的 service account。
3. 将 topic 完整资源名设置为 `GMAIL_PUSH_TOPIC`，service account 邮箱设为 `GMAIL_PUSH_IDENTITY`。服务端校验 RS256 签名、issuer、audience、email、email_verified、过期时间；不接受匿名 Pub/Sub。
4. 登录管理网页，选择已有 Gmail 账号后点击“启用服务商推送”。定期续期，并保留 history/周期对账。通知中的 historyId 只作提示，不覆盖已提交检查点。

Graph 推送同样在账号管理页开启，回调为 `BASE_URL/webhooks/graph`，必须公网可访问的 HTTPS。端点处理 validationToken，并按订阅 ID 和加密保存的随机 clientState 验证通知。基础通知不要求正文资源随回调传输；服务端以原账号权限查询增量。生命周期事件会请求续期与对账。远端停止结果不确定时，本地先禁用通知处理，远端订阅可能保留至其到期。撤销连接后，本地不再接收该账号的工作；已发出的远端请求不能保证撤回。

查看推送状态要求 `mail.read`；启停 Gmail/Graph 推送要求账号所有者同时具有 `mail.read` 和 `mail.write`（连接配置管理权限）。邮箱的 `writable=false` 策略不妨碍该所有者配置只读同步通知。续期暂时失败时，保留仍有效的旧订阅期限/身份，避免提前丢弃合法回调。

这些端点已实现并通过合成通知/签名及请求契约验证；本任务没有配置公网 Pub/Sub、在真实 Microsoft 租户创建订阅或触发真实邮件推送。[Gmail 推送指南](https://developers.google.com/workspace/gmail/api/guides/push)、[Pub/Sub JWT 校验](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)、[Graph 回调协议](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)。

JMAP 服务若在不同主机提供 API/上传/下载，设置 `JMAP_ALLOWED_ORIGINS=https://api.example.com,https://files.example.com`。只接受规范化 HTTPS origin（无路径、账号密码、尾部斜杠），不接受用户在连接参数传入白名单。名单主机会收到该 JMAP 账号的 Bearer token，因此由管理员逐一确认服务商；不同信任域可用不同部署。网络出口的私有地址/端口限制及 TLS 验证继续生效，HTTP 重定向不自动跟随。

0.2.0 的 schema v2 是本次升级门槛；现库不能直接用 0.1.0 镜像回退。选择同样支持 v2 的已验证镜像回滚。若需跨 schema 退回，只能先在隔离环境演练受控数据迁移并核对升级后所有外部发送；**不能直接恢复旧 operations 快照**，否则可能重发已经投递的邮件。
