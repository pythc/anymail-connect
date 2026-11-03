# 自托管、身份与运维

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

## MCP 与插件包

MCP 地址为 `BASE_URL/mcp`，发现文档为 `BASE_URL/.well-known/oauth-protected-resource`。在 ChatGPT 的自定义 MCP 连接中选择预注册 OAuth client，使用 `anymail-chatgpt`、PKCE、token endpoint auth method `none`；回调 URI 从目标连接页面复制，不使用通配符。

复制 `plugin/mcp.template.json` 为包根 `mcp.json`，替换部署 URL，与 `plugin/plugin.json` 一起打包。不要把邮箱密码、OAuth secret、access token 或固定 Authorization header 放进包。模板尚未提交目录审核，插件包不等于公开可安装产品。

## 备份、升级与回滚

- 备份 PostgreSQL 和**独立保存的加密密钥**；丢失密钥后凭证不可恢复。默认没有密钥轮换迁移，不要直接换密钥后重启。
- 升级前停止 worker 领取新任务，等待正在提交的操作结束；记录 unknown 操作并人工对账。备份须在隔离数据库演练恢复。
- 应用 schema v1 为非破坏性首次建表；发现更新的 schema_version 时旧程序拒绝启动，防止静默不兼容回滚。未来迁移遵循 expand/contract，不能仅靠当前建表脚本宣称后续版本已可回滚。
- 本轮新增发送绑定字段；升级后旧格式 pending/approved 意图会拒绝提交，需取消后重新准备并确认。不可把旧批准默认解释为新格式批准。
- 回滚不得清空 operations 表、重建发送意图或把 unknown 改回 approved。回滚到兼容镜像，保留同一台账与密钥。
- 撤销账号连接清除凭证、缓存与草稿，取消 pending/approved；已开始提交的邮件不能保证撤回。审计与 operations 保留发送证据，备份中的旧数据按部署方保留策略清理。
- 日志只写操作状态，不记录邮件正文和凭证。更细致告警、保留清理和生产容量目标由试点测量后确定。

未在此任务中部署到公网、申请审核或接入个人真实邮箱。
