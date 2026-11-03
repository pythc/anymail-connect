# anymail-connect 可行性调研

调研日期：2026-11-04（Asia/Shanghai）。面向个人与企业用户，先建设统一底座。

## 1. 结论与前提校正

**项目可行，但应将目标改为“广泛接入、分层能力、逐项对齐”，不能承诺无条件覆盖所有邮箱并复制官方插件的全部体验。** 建议以 Gmail API、Microsoft Graph、IMAP/SMTP 三条接入路径组成底座，通过 MCP 提供工具，再以可选插件 UI 和扩展完成展示。

“ChatGPT 只有微软和谷歌邮箱插件”不是普遍事实。本次调研会话已能发现一个名为“QQ 邮箱”的插件，工具描述包含列信、搜索、读信、准备草稿和发送。这里只检查了工具元数据，没有访问邮件，没有核实目录对其他账号的开放范围，也不能由此认定该插件由 OpenAI 官方开发。官方文档说明，插件可包含 MCP 服务、技能与可选 UI，目录和可用入口还受客户端及工作区影响。[OpenAI 插件概览](https://learn.chatgpt.com/docs/plugins)

“一样”需要拆成三个可检验目标：

1. **任务结果对齐**：能否完成搜索、读信、回复、转发、附件、整理等任务。
2. **服务商语义对齐**：是否保留 Gmail 标签/会话、Outlook 分类/联系人/共享邮箱等语义。
3. **宿主体验对齐**：ChatGPT 是否展示预览、引用、附件、编辑和确认界面，是否支持知识源检索及跨端使用。

第一项大部分可做；第二项必须使用原生扩展和能力声明；第三项有公开扩展接口，但不能由一个 MCP 服务自行保证。任何“完全一致”结论都必须有目标账号和客户端上的端到端证据。

## 2. 官方插件基线比“收发邮件”更宽

当前会话中的 Gmail 工具元数据显示：搜索、单封及批量读取、会话读取、附件读取、草稿创建/修改/列表/发送、直接发送、转发、标签查询/创建/应用、归档、删除和批量整理。

Outlook 工具元数据显示：列表/搜索、单封及批量读取、附件列举/下载/添加、草稿、回复/转发草稿与直接发送、已读状态、移动、分类、定时发送、联系人及联系人文件夹管理、退订头读取及 mailto 退订。部分工具还提示共享邮箱工作流，但本次工具目录未提供完整的共享邮箱工具集，不能认定已具备全部能力。

这是一份**特定会话可观察基线**，不是公开、永久不变的官方产品规范，也没有调用这些工具验证执行结果。完整对照与尚未解决的边界见[功能矩阵](capability-matrix.zh-CN.md)。

## 3. 邮箱接入分层

| 层级 | 建议接入 | 覆盖与限制 |
| --- | --- | --- |
| Google | Gmail API + OAuth | 保留标签、会话、草稿及增量历史；普通 Gmail 与 Workspace 分开验收 |
| Microsoft | Microsoft Graph + OAuth | 个人 Outlook 与 Exchange Online 分开验收；共享/委派需额外权限 |
| 标准邮箱 | IMAP + SMTP | 适合 QQ、163、iCloud、企业标准邮箱；联系人、标签、搜索语法和草稿行为不统一 |
| JMAP | 后续原生适配 | 标准支持查询、组织、提交与同步；是否可接取决于服务端和账号开放能力 |
| 私有/加密邮箱 | 桥接或专用适配 | 如 Proton Bridge；不能默认通过云端 IMAP 直接访问 |
| 旧企业环境 | 管理员配置的专用适配 | 先核实协议、身份和网络；EWS 只作为必要的本地 Exchange 扩展评估 |

Google 的全量与增量同步有公开接口；历史游标失效会要求重新全量同步。Graph 的邮件 delta 是按文件夹跟踪，不能用一个收件箱游标代表全邮箱。[Gmail 同步](https://developers.google.com/workspace/gmail/api/guides/sync)、[Graph delta](https://learn.microsoft.com/en-us/graph/delta-query-messages)

网易官方帮助明确要求为第三方客户端新增授权密码。QQ 的腾讯旧帮助页面本次只返回导航，未取得有效正文；阿里云自己的 QQ 连接器文档明确采用 IMAP/SMTP 和授权码，可作为接入路径的旁证，不能替代腾讯完整兼容性认证。[网易帮助](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089)、[阿里云 QQ 连接器](https://help.aliyun.com/zh/model-studio/connector/qq-mail)

Apple 明确提供 iCloud IMAP/SMTP 设置及应用专用密码。Proton 的标准客户端接入依赖桌面 Bridge，当前官方说明要求付费 Mail 方案；Bridge 在本地解密，把解密后的邮件交给 AI 仍会产生新的数据流，不能宣称端到端加密边界保持不变。[iCloud](https://support.apple.com/en-us/102525)、[Proton Bridge](https://proton.me/support/imap-smtp-and-pop3-setup)

**截至调研日，Microsoft 文档写明 Exchange Online EWS 已进入从 2026 年 10 月开始的分阶段禁用期，计划 2027 年 4 月完全禁用。** 这不意味着今天所有租户都已关闭 EWS，也不等于本地 Exchange Server 的 EWS 同时退役。新项目不能以 EWS 作为微软云邮箱主路线。[当前退役说明](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online)、[分阶段计划](https://techcommunity.microsoft.com/blog/exchange/exchange-online-ews-your-time-is-almost-up/4492361)

## 4. 可复用产品与竞争判断

| 路径 | 已有价值 | 对本项目的代价或缺口 | 建议 |
| --- | --- | --- | --- |
| EmailEngine | 自托管统一邮件 API；已有 MCP 测试版；支持 IMAP/SMTP、Gmail API、Graph | source-available，持续运行需要商业许可；其 MCP/UI 与目标 ChatGPT 的完整兼容性仍须验证 | 最快的购买/验证对照组，可选后端适配 |
| Nylas | 托管统一 API；已有 MCP；邮件、联系人等能力 | 供应商成本、数据驻留、账号权限和编码限制；当前 MCP 文档主要展示 API key 接入，不等于可直接提交 ChatGPT 公开目录 | 可选托管后端，对用户明确数据处理链 |
| 自研薄底座 + 成熟库 | 可控制协议差异、部署、许可证与国内邮箱适配 | 同步恢复、凭证、权限、错误语义和长期兼容性均需自己维护 | **推荐项目主线** |
| 从零写邮件协议栈 | 理论上完全控制 | 重复造轮子，兼容和安全成本高 | 不推荐 |

EmailEngine 官方页面当前列价为每年 1,450 美元或 1,200 欧元、未含 VAT、邮箱数不限；这是软件授权报价，不包括基础设施或本项目开发成本，购买时须重新核价。其官方文档说明 MCP 仍标为 beta，工具集可能变化。[产品与价格](https://emailengine.app/)、[MCP 文档](https://learn.emailengine.app/docs/mcp)

Nylas 也已有 MCP。因此“通用邮箱 + MCP”本身不足以构成差异。其 IMAP 文档还列出服务商速率、编码、消息格式和搜索限制，说明统一 API 不能消除底层差异。[Nylas MCP](https://developer.nylas.com/docs/dev-guide/mcp/)、[IMAP 限制](https://developer.nylas.com/docs/provider-guides/imap/)

建议差异化：透明许可证的自托管底座、国内个人/企业邮箱的公开实测矩阵、可靠的中文邮件与附件处理、明确的发送状态、企业多账号隔离，以及针对 ChatGPT 的任务和 UI 验收。开源是建议定位；公开仓库的许可证仍需项目拥有者确定。

## 5. ChatGPT 接入路径

官方现行路径允许将自定义 MCP 创建为插件：对私有数据提供 OAuth 授权，暴露 Streamable HTTP；测试可使用公共 HTTPS 或 Secure MCP Tunnel，公开插件提交需要稳定公共 HTTPS、域名验证和审核材料。账号和工作区策略仍可能限制入口。[构建 MCP](https://developers.openai.com/plugins/build/mcp-server)、[连接测试](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[公开提交](https://developers.openai.com/plugins/deploy/submission)

授权分两层：ChatGPT 登录 anymail-connect；anymail-connect 再取得邮箱服务商授权。QQ/163 等授权码在本服务的安全设置页录入，不交给模型或普通工具参数。不能把 Gmail/Graph token 原样当作本 MCP 的 token；本服务必须校验自己的 audience 与权限。[OpenAI OAuth](https://developers.openai.com/plugins/build/auth)、[MCP 安全说明](https://modelcontextprotocol.io/docs/draft/tutorials/security/security_best_practices)

UI 可以通过 MCP Apps 做列表、阅读、编辑和确认；公开扩展还提供侧栏、文件查看器和 composer mentions。可以实现接近宿主风格的流程，但不能据此推断能够复用官方 Gmail 的私有文件句柄、内部 UI 或后台同步实现。[UI](https://developers.openai.com/plugins/build/chatgpt-ui)、[扩展](https://developers.openai.com/plugins/build/extensions)

若要作为 Company knowledge 来源，按官方要求增加标准 `search` / `fetch`、只读标注和用户可打开的来源 URL。符合工具格式只是兼容前提，不是自动获得索引、检索质量或目录资格的保证。[官方服务构建说明](https://developers.openai.com/plugins/build/mcp-server)

## 6. 最容易低估的工程工作

- **同步与标识**：IMAP UID 只在账号、文件夹和 UIDVALIDITY 范围内有效；移动、重建和断线会改变映射。Gmail 标签不等于 IMAP 文件夹。[IMAP 标识规范](https://www.rfc-editor.org/rfc/rfc9051)
- **发送不确定性**：SMTP 最后确认丢失、Graph 接受后超时，都可能无法判断是否已发送。Graph 的 202 不代表投递成功。业务幂等键不能保证所有外部服务器恰好发送一次。[Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)、[SMTP](https://www.rfc-editor.org/rfc/rfc5321)
- **搜索与线程**：中文正文、附件全文、Gmail 操作符和 Graph 搜索不是同一个功能；要显式返回搜索范围、同步新鲜度和线程推断来源。
- **附件与 HTML**：MIME 解析不等于 HTML 安全处理；MailParser 官方文档明确不负责 HTML 清洗。文件必须限流、限大小，并对远程图片默认禁载。[MailParser](https://nodemailer.com/extras/mailparser)
- **联系人与日历**：不属于通用 IMAP/SMTP；联系人需 Graph、People API、CardDAV 或其他扩展。日历不纳入本期邮件基线。
- **企业权限**：管理员授权、共享邮箱、条件访问、网络白名单和不同云环境都要单独适配，不能依赖一个 OAuth 登录框解决。
- **运营成本**：长期连接、重同步、索引、存储、附件解析、审计和供应商审核，比工具 JSON schema 更影响成本。

## 7. 推进建议

以两周可行性验证为第一投资门槛，先证明目标 ChatGPT 账号接得上、三类后端可以完成受控读写、未知发送状态不会自动重发。随后按[路线图](roadmap.zh-CN.md)推进。若项目需求只是个人短期可用，而不准备维护上述差异，先采购已有服务会比建设新平台更合理。

本次完成的是文档调研与仓库初始化。没有接入真实邮箱、付费采购、申请第三方审核、部署服务、测试发送或验证 ChatGPT 新插件安装。
