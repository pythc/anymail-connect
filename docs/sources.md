# 来源与证据边界

核对日期：2026-11-04（Asia/Shanghai）。资料均来自服务商、协议组织或组件维护方；不以博客转载、搜索摘要或厂商宣传代替本项目实测。

## 1. OpenAI / ChatGPT

以下页面通过官方 OpenAI 文档工具或官方站点打开，读取与本项目相关的正文。一次文档工具网络失败后，使用官方站点补读了连接测试页面。

| ID | 一手来源 | 支撑范围 |
| --- | --- | --- |
| O1 | [Plugins](https://learn.chatgpt.com/docs/plugins) | 插件组成、支持的使用入口、目录与安装/权限模型 |
| O2 | [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server) | SDK、Streamable HTTP、工具注解、服务端授权、profile、Company knowledge search/fetch 要求 |
| O3 | [Authentication](https://developers.openai.com/plugins/build/auth) | OAuth 2.1、PKCE、metadata/resource、客户端注册方式、多账号身份 |
| O4 | [Add UI](https://developers.openai.com/plugins/build/chatgpt-ui) | MCP Apps、可选 UI、结构化工具与 UI 解耦、文件能力扩展需探测 |
| O5 | [Plugin Extensions](https://developers.openai.com/plugins/build/extensions) | 侧栏、文件查看器、深链与 composer mentions 的公开扩展入口 |
| O6 | [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt) | 自定义 MCP 创建为插件、测试端点、账号/工作区策略、评估与刷新 |
| O7 | [Upload and submit](https://developers.openai.com/plugins/deploy/submission) | 公开 HTTPS、域名验证、OAuth 配置、测试账号、审核与发布分别处理 |

页面是调研日的公开文档，不是当前用户已经拥有入口/权限的证明。未创建或安装新 ChatGPT 插件，未提交审核。

## 2. 邮箱服务商与协议

| ID | 一手来源 | 支撑范围与限制 |
| --- | --- | --- |
| P1 | [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) | scopes 分类；restricted scope 服务端处理的验证/评估要求；适用例外需具体核实 |
| P2 | [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync) | 全量/增量、history 失效返回 404 后重新同步 |
| P3 | [Graph mail overview](https://learn.microsoft.com/en-us/graph/outlook-mail-concept-overview) | 邮件、文件夹、分类、联系人关系、主要云邮箱范围；不证明每个账号均可授权 |
| P4 | [Graph delta messages](https://learn.microsoft.com/en-us/graph/delta-query-messages) | 每文件夹增量、nextLink/deltaLink 与游标管理 |
| P5 | [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0) | Mail.Send、JSON/MIME、202 仅表示接受，非投递完成 |
| P6 | [Exchange Online EWS deprecation](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-ews-exchange-online) | 2026-10 开始分阶段禁用、2027-04 完全禁用；文档列出的能力 ETA 不是已交付证明 |
| P7 | [Exchange phased disablement](https://techcommunity.microsoft.com/blog/exchange/exchange-online-ews-your-time-is-almost-up/4492361) | 云与本地 EWS 区别、管理员与 Allow List 过渡行为；由 Microsoft Exchange 团队发布 |
| P8 | [iCloud server settings](https://support.apple.com/en-us/102525) | IMAP/SMTP、认证名、应用专用密码 |
| P9 | [Proton IMAP/SMTP setup](https://proton.me/support/imap-smtp-and-pop3-setup) | 桌面 Bridge、当前付费要求、加解密位置与平台范围 |
| P10 | [网易如何新增授权码](https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089) | 网页解析仅显示导航；另从同一官方页面 HTML 正文核实新增授权密码步骤；仍未测试账号 |
| P11 | [阿里云 QQ 连接器](https://help.aliyun.com/zh/model-studio/connector/qq-mail) | 阿里云对其自身 QQ 接入方案的一手说明：IMAP/SMTP、授权码；不是腾讯对本项目的认证 |
| P12 | [阿里云网易连接器](https://help.aliyun.com/zh/model-studio/connector/netease-mail) | 阿里云对自身 163 连接流程与凭证处理的说明，不外推所有网易品牌或企业套餐 |
| S1 | [IMAP RFC 9051](https://www.rfc-editor.org/rfc/rfc9051) | UIDVALIDITY/UID/文件夹范围、标志、IDLE；不代表所有现存邮箱支持 rev2 全部能力 |
| S2 | [SMTP RFC 5321](https://www.rfc-editor.org/rfc/rfc5321) | 提交、接受与投递的协议背景；发送恢复策略为本项目设计 |
| S3 | [JMAP Mail RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) | 邮件查询、提交与同步模型，不代表任意邮箱开放 JMAP |
| S4 | [MCP security best practices（draft 文档）](https://modelcontextprotocol.io/docs/draft/tutorials/security/security_best_practices) | token audience/passthrough、confused deputy、SSRF 等指导；实现需锁定实际协商的规范版本 |

腾讯旧页面 [service.mail.qq.com/detail/0/75](https://service.mail.qq.com/detail/0/75) 本次返回帮助导航，未取得所需正文，未据此认证 QQ 授权行为。企业微信/腾讯企业邮箱完整官方协议与 API 文档未完成核实，因此服务商矩阵保留“候选/待实测”。

Graph 概览与 EWS 迁移路线图对归档能力的描述可能处于不同更新时间；路线图出现 Q4 2026 的 ETA 不证明功能已经发布。本计划未把原位归档或公共文件夹完整 CRUD 列为首版保证能力。

## 3. 现成产品与组件

| ID | 一手来源 | 支撑范围 |
| --- | --- | --- |
| C1 | [EmailEngine](https://emailengine.app/) | 自托管统一 API、协议覆盖、source-available 与持续运行许可、调研日年费报价 |
| C2 | [EmailEngine MCP](https://learn.emailengine.app/docs/mcp) | 已提供 MCP、beta 状态、邮件与管理工具、账号范围和凭证隔离设计 |
| C3 | [Nylas MCP](https://developer.nylas.com/docs/dev-guide/mcp/) | 已提供 MCP；当前公开配置主要展示 API key 认证和工具范围 |
| C4 | [Nylas IMAP](https://developer.nylas.com/docs/provider-guides/imap/) | IMAP/SMTP 接入与吞吐、编码、格式、搜索等限制；不是本项目已具备同样行为 |
| L1 | [ImapFlow](https://imapflow.com/) | IMAP 客户端能力与维护方标注的 MIT 许可 |
| L2 | [Nodemailer](https://nodemailer.com/) | SMTP/邮件构造能力；现行官网标注 MIT-0，实施前按固定版本复核 |
| L3 | [MailParser](https://nodemailer.com/extras/mailparser) | MIME/流式解析、编码和 HTML 未清洗的安全边界；官网标注 MIT |

EmailEngine 与 Nylas 的功能和价格为厂商当前自述，未购买、压测或执行产品验收；不能把其示例承诺当成本项目性能数据。引用仅用于建设/采购判断，不复制商业实现。

## 4. 本地可观察证据

调研会话可发现 Gmail、Outlook Email、QQ 邮箱工具元数据。仅读取目录中的名称/描述，以确认可观察功能并校正“只有两类邮箱”的前提；没有读取账号资料、邮件、附件或联系人，也没有执行发送。

这类元数据不具有可公开复现的固定 URL，故单独披露，未伪造官方产品规范。后续应在有权限的目标账号上导出脱敏工具清单、记录日期与客户端，再冻结验收基线。

## 5. 尚未验证

- 新 anymail-connect 服务在任何客户端上的实际可用性。
- 各品牌/套餐/地区的当前协议开关、限额、授权流程与服务器特性。
- 目标用户的插件入口、目录发布资格、OAuth 审核或企业管理员授权。
- 邮件/附件真实性、收发成功率、投递率、搜索召回、同步完整性与性能。
- 多租户安全、真实生产回滚、备份恢复与合规审计结果。

所有工期、容量假设、架构、接口与路线选择均属于建议或估算；不会因为文档已发布而变成测试事实。
