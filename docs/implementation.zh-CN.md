# 0.2.0 实现与验证状态

日期：2026-11-04。此文档与 TODO.md 描述当前实现；原调研/架构文档保留为历史设计，不能用其“尚未开始”作为当前代码状态。

## 已有实现

- TypeScript 服务、PostgreSQL schema/迁移、API 和独立持久 worker，HTTP MCP 使用官方 SDK 的无会话 Streamable HTTP。
- OIDC 发现、RS256/ES256 JWT 签名/issuer/audience/client/tenant 校验；浏览器授权码 + PKCE、服务端加密会话、CSRF。附 Keycloak 配置模板，不自研登录协议。
- 个人/企业使用相同的 tenant/subject/account 隔离。账号配置写入、凭证 AES-256-GCM 加密、按账号刷新 OAuth token、撤权清理、审计记录。
- Gmail API、Graph、IMAP/SMTP、JMAP 适配器；原生服务商能力和缺失能力显式返回，不承诺品牌账号认证。
- 查询/分页/正文/会话、附件元数据/鉴权下载、已读/标记/移动/垃圾箱、批处理部分失败；Gmail 标签、Graph 分类/文件夹/联系人和联系人文件夹。
- 应用草稿 CRUD/revision、回复/全部回复/转发及显式选择原附件复制、Gmail/Graph 原生草稿导出（独立副本），附件上传与固定内容发送意图。
- 可信浏览器确认绑定发件身份、文件字节 SHA-256 与可鉴权检查的附件清单，幂等键、并发提交互斥、计划发送/取消、重启后未知提交不重试。SMTP 信封保留 Bcc，但实际发送的 MIME 隐藏 Bcc 头。
- Gmail history、Graph 单文件夹 delta、其他协议的有界周期对账；同步页和游标与缓存同事务保存，租约防止过期 worker 覆盖新 worker。
- `search`/`fetch` 来源接口、profile、MCP 只读预览资源、插件包装模板；管理网页提供连接、搜索、读取、附件上传、草稿和确认。
- 文本/JSON/XML/PDF/DOCX 附件文本提取：8 MiB 输入、100,000 字符输出、PDF 最多 50 页、worker 超时/内存限制；DOCX 解压计数与展开大小限制，不写入文件系统。未提供 OCR 或任意格式全保真解析。
- IMAP IDLE 有界连接池、跨 worker 租约与轮转，Gmail Pub/Sub JWT / Graph clientState 回调、续期和重启恢复，独立持久同步队列；通知期间新信号用 token 保留。
- 容器构建、Compose、CI、部署与回滚说明；schema v2 阻止旧程序误读新的云环境凭证。

## 验证层次

| 层次 | 当前证据 |
| --- | --- |
| 类型与构建 | `npm run typecheck`、`npm run build` |
| PostgreSQL 兼容实现 | PGlite 测试；另用独立 PostgreSQL 17 实例重复数据库/HTTP/并发测试 |
| IMAP/SMTP | 本机实际 TLS 协议服务器；登录、BODY.PEEK、flags、UIDVALIDITY、SMTP MIME/Bcc、Sent 副本 |
| Gmail/Graph/JMAP | 适配器请求契约及响应夹具、权限/分页/游标/错误/提交行为；未连接真实云邮箱 |
| HTTP MCP | 真实官方 SDK client 经 HTTP 初始化、工具发现、调用 |
| 浏览器 | 合成账号会话，桌面 1280px 和移动 390px；搜索/读信/草稿/Bcc/可信确认，无页面脚本错误 |
| OIDC | JWT 正反例、cookie/CSRF/Origin/Host 测试；实际本机 Keycloak 26.8.1 完整授权码登录通过，部署方 IdP/MFA/企业策略尚未验收 |
| 安全审查 | 0.2.0 记录见 [变更与验证](release-0.2.zh-CN.md)，原 [0.1.0 扫描](review.zh-CN.md) 为历史证据；发现工具或启动扫描本身不代表扫描通过 |

## 明确限制与尚未实现的增强

1. **未认证服务商品牌**：QQ、163、iCloud、Workspace、Outlook/M365、共享邮箱、Proton Bridge、企业内网仍需真实账号验证。HTTP 夹具和协议实验室不能代替这些验收。
2. **宿主能力**：MCP Apps 预览与插件包属于可测试实现；未在 ChatGPT web/desktop/mobile 安装验收。附件下载 URL 需要当前用户认证；不冒充官方内部 file_uri。`attachments_read` 提供文本提取，但宿主文件上传/原生展示仍需验证。
3. **草稿位置**：默认应用内草稿。原生导出是独立副本，不自动同步后续编辑；未知导出结果不能自动重试。IMAP 不使用非原子 APPEND/删除伪装原子原生草稿更新。
4. **检索与同步**：常驻 worker 保留周期对账，并为 IMAP 提供有界 IDLE 池、Gmail/Graph 提供可选推送；Gmail 原生同步覆盖 token 可见邮件，Graph 需对各文件夹分别调用 `sync_page`。缓存仅表示已同步范围，不是完整实时邮箱索引。通知只推进已有账号的同步，不会主动启动 AI 对话；Graph 委派共享邮箱推送不支持，继续对账。未实现语义向量或附件全文索引。
5. **能力边界**：Graph 支持 global/usgov/usgovdod/china 静态端点与对应 OAuth/刷新路径；各云仍需真实账号验收。未实现专用 EWS、Google People、CardDAV；JMAP 跨 session origin 的 API/下载/上传须由管理员配置精确 HTTPS origin 白名单。IMAP 线程为最近 50 封内的 References 推断，不宣称完整会话。
6. **企业策略**：目前账号归创建用户所有；共享邮箱依赖该用户自己的 Graph 委派权限，未提供跨用户共享凭证或管理员全域扫描。后台已批准的发送是持久授权，注销网页会话不会取消计划；撤销账号连接会取消尚未提交的操作。JWT 的全局撤权取决于 token 到期，未配置逐请求 introspection。
7. **运维**：Compose/镜像和配置说明不是生产部署或压测结果；备份恢复、第三方审核、真实生产回滚仍待完成。附件解析 worker 是资源隔离，不等于操作系统级恶意文件沙箱。
8. **许可**：仓库公开但项目许可证未选择，当前 package/plugin 标为 UNLICENSED。

未完成增强保留在 TODO，不标记“全部功能与官方一致”。这些限制不影响运行现有实现，但限制了可对外声称的支持范围。
