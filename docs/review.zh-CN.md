# 0.1.0 代码审查与验证记录

日期：2026-11-04。结论限于已审查源码及本地合成环境；尚未完成真实邮箱、目标 ChatGPT 或生产验收。

## 范围与审查结果

初始实现冻结在 `c5375898874517cd997dd09a235882eb1bdd9bfa`，审查基线为 `8a6fd73a1cfdc47ef6610594973f59abd321623f`。人工审查覆盖身份与 MCP、凭证/数据库/发送/同步/附件解析、四个适配器、网络出口、容器/配置及测试。对审查修复又进行了逐文件复核。

Codex Security diff scan 已完成并封存，ID 为 `93b2ea6a-cfe2-49aa-9d5d-db7426b8770e`：36 个权威源码审查条目均已覆盖，1 个低风险确认问题，无未完成源码条目。生成依赖锁通过结构检查和 npm audit 验证，未对全部第三方依赖源码进行穷举审计。

该问题为：可信发送确认页没有显示实际发件账号和可识别附件清单。生产 renderer 的隔离复现证明不同账号可以显示相同预览；既有账号归属、浏览器点击、CSRF 和 revision 检查有效，未证明静默发送或跨租户访问。

修复在冻结扫描之后完成：

- 服务端准备意图时解析发件邮箱和附件名称、类型、字节长度、文件字节 SHA-256，连同账号、草稿版本、内容与计划时间纳入规范化摘要；规范化避免 PostgreSQL JSONB 重排键影响验证。
- 确认页显示全部绑定信息，提供当前用户鉴权的附件检查链接；批准和提交前重新检查，缺少新绑定字段的旧意图拒绝继续提交。
- 撤权和批准/提交统一采用 account → operation → draft 的锁顺序。
- 回归测试覆盖发件身份变化、附件字节变化、旧格式意图、附件跨主体下载、审批后改稿和并发/重复提交。

正式扫描结论仍是冻结版本的 1 个低风险问题；修复代码经过人工复核和回归，未另行声称对最终版本完成第二次完整扫描。

另外修复了已确认的功能问题：Gmail/JMAP 遗漏 Cc、Reply-To 和引用字段，Gmail 引号地址与字符集/纯 HTML 正文/内嵌附件，Graph 完整 HTML 文本与显式邮件头选择，IMAP 大邮件导致整页列表失败，MCP 搜索丢失范围/续页信息，以及网页切换账号后的延迟返回污染。未知字符集使用兼容解码或带警告的替换回退；引用 fetch 保留该警告。

Graph 邮件头需显式 `$select`，实现依据为 [Microsoft Graph get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0)。Gmail MIME part 可能将内容放在 `data` 或单独附件中，依据为 [MessagePartBody](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments)。JMAP 回复字段映射依据 [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.html)。

## 已执行验证

- `npm run check`：69 项通过，0 失败、0 跳过（Node test runner 统计）。包括租户/主体/权限隔离、CSRF、实际 HTTP MCP SDK client、真实 TLS IMAP/SMTP 实验室、发送并发/未知结果/撤权/计划取消、附件解析以及服务商请求契约。
- 同一套测试在独立本机 PostgreSQL 17 和 PGlite 运行；Gmail/Graph/JMAP 为 HTTP 合成响应，不代表真账号验证。
- Python Playwright + Chrome：1280px 桌面和 390px 移动布局；搜索/阅读、Bcc 与附件预览、可信确认；延迟搜索与草稿准备请求跨账号切换后不污染新账号，无页面脚本错误。
- `npm run build`、`npm run format:check`、`git diff --check`；`npm audit --omit=dev --audit-level=high` 最近成功结果为 0 漏洞。

另执行实际 Keycloak 26.8.1 + Playwright 登录实验（不是预置会话）：服务发现、授权码/PKCE、nonce/state、远程 JWKS、sub/tenant/client/audience/scopes、cookie、CSRF 退出通过。实验发现并修复模板缺少 access-token sub 映射及应用多余 profile scope 两项真实集成问题。入口为 `npm run test:oidc`，复现见部署文档。

源码复核还修复上传权限检查和落库之间的撤权竞争：普通文档写入改为在账号锁内重新检查，显式事务调用方先锁账号；暂停上传后撤权、再恢复上传的回归证明不会重新写入私有数据。回复/转发增加 `source_attachment_ids` 显式附件选择，并检查来源归属和实际字节预算。这些均为封存扫描后的人工复核与测试证据。

最终源码镜像 `anymail-connect:validation` 构建通过，image ID 为 `sha256:5c013c7a3591ad63a1ab29ff4c1bee46533e885387a39699a7598783b96da337`（本机验证镜像，未发布镜像仓库）。在 `--network=none` 容器中执行编译后的 Gmail 完整正文映射、提取 worker 和 PDF 模块加载 smoke 通过。此结果不代表公网部署。

Gitleaks 对当时 3 个 Git 提交扫描，结果未发现凭证泄漏；未将 `.env`、生成的 realm、测试会话或其他忽略目录加入提交。

## 边界与下一关

- 不把合成服务商响应、测试 HTTP token 或协议实验室等同于个人/企业真账号。
- 尚需目标 ChatGPT 安装/OAuth/文件/UI、服务商 OAuth 公共审核、具体企业条件访问/共享邮箱、生产备份恢复及容量验收。
- 推送 GitHub 和 CI 结果以实际 commit/run 回执为准；构建通过不等于生产部署成功。
- 尚未实现的增强见 [TODO](../TODO.md)，不能归类成“只差账号验收”。

## 扫描计量

插件返回 `coverage=complete`、`source=codex_rollout`，涉及 5 个线程：总 token **22,090,634**，输入 **22,037,447**（其中缓存输入 **21,804,160**），输出 **53,187**。这是插件按关联 rollout 统计的用量，包含上下文/缓存，不是本项目代码规模、独立推理量或费用估算。
