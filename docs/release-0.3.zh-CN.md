# 0.3.0 剩余开发项与验证

日期：2026-11-04。本轮针对 TODO 中剩余可开发的功能；真账号、云端配置、宿主安装、生产验收和许可证决策保留为外部事项。review/远程 CI 完成前不写为交付成功。

## 实现范围

| 条目 | 实现 | 边界 |
| --- | --- | --- |
| Google People | Gmail/Workspace 联系人分页、读取、创建、etag 更新、删除 | 旧授权须重新同意 contacts 权限；不是全域目录扫描 |
| CardDAV | 任一邮件连接可附带通讯录 URL/独立凭证；REPORT、读取、创建、If-Match 更新/删除 | 显式地址簿 URL；单次最多 500 条快照、50 条分页；不自动发现或跨 origin 发送凭证 |
| 企业 EWS | 管理员精确批准 HTTPS origin；指定邮箱查读/附件/文件夹/已读/移动/垃圾箱/MIME 发送、联系人 CRUD | 本地 Exchange、Basic-over-TLS 或预置 Bearer；没有 NTLM/Kerberos、自动发现或应用全域模拟。特殊搜索组合显式拒绝；非完整 Exchange 产品兼容认证 |
| MCP Apps | 邮箱选择、搜索/阅读/附件资源、草稿 To/Cc/Bcc 编辑、版本保存、回复、可信确认链接；宿主文件选择能力检测与回退 | 隔离宿主夹具验证，不代替 ChatGPT 安装；不在 iframe 批准发送 |
| 宿主文件 | `openai/fileParams` 输入、受管理员 origin 限制的下载与私有上传；标准 MCP resource_link/resources.read 输出 | 不伪造官方 file_id；实际宿主文件库/文件展示能力仍须安装验收 |
| 原生草稿 | Gmail/Graph 既有草稿导入、后台拉取、可选自动写回、双方变化冲突、显式版本化选择、停止关联和未知状态不重试 | Gmail 无已核实的原子 CAS；Graph 发送版本条件头，真实租户语义待验收；Graph 支持小于 3MB 文件附件替换，部分失败停为 unknown。IMAP/JMAP/EWS 保留应用草稿 |
| 文本提取 | 增加 PPTX/XLSX/ODT/ODS/ODP/RTF/HTML；复用 ZIP 总展开/条目/内存/时间限制 | 文本提取而非全保真转换；不执行宏、不访问外链，不覆盖所有旧二进制 Office 格式 |
| OCR | 显式 PNG/JPEG OCR，容器自带 Tesseract 与英/简中语言包；8 MiB、1600 万像素、6 秒子进程期限/单线程/输出限制，单 API 进程最多一笔 OCR，Linux 子进程 512MiB 地址空间限制 | 默认关闭；未做扫描 PDF 页面渲染 OCR；原生解析器不是 OS 沙箱 |
| 附件全文 | 显式单附件索引、原字节摘要、中文子串检索、分页和删除；每用户/账号最多 500 条 | 私有快照，不是全邮箱或语义检索；需重索引才能反映源附件变化 |
| 团队权限 | 所有者向同租户不可变 subject 授予读/写/发送与到期时间；即时收回、过期检查、旧审批取消 | 关联通讯录也属账号权限。凭证只由所有者管理；应用草稿、上传、索引按使用者私有；服务商原生草稿属于共享邮箱内容。已发出的请求无法撤回 |
| 集中 token 检查 | 可选每请求 introspection，仍先验证 JWT；scope 只取交集；浏览器会话也在线检查 | IdP 故障/失效令牌拒绝访问；既有持久发送审批及显式启用的原生草稿自动写回不因网页注销或 token 到期自动取消，仍受账号/共享权限撤销约束 |
| 密钥轮换 | 唯一 key ID、旧密钥环、旧密文兼容读取；dry-run/显式 apply，账号锁和幂等迁移覆盖账号/push/session | 须先把所有写节点升级到同一密钥环；旧备份仍需独立保留相应旧密钥 |
| 保留清理 | worker 定期按策略清理缓存/索引、草稿/上传/审计与过期授权；保护活动发送和关联草稿 | 缓存/索引默认 30 天，草稿/上传/审计默认不自动删除。发送台账/幂等记录不删，缺少旧时间戳的数据保留 |

## 当前验证

修复后的 PGlite 与独立 PostgreSQL 17 完整测试各 122 项通过、无失败/跳过；包含共享权限/租户/私有数据、撤权/降权/过期审批、轮换 dry-run/apply/重跑、保留引用、原生草稿冲突/未知结果/停止竞争、联系人/XML/EWS 请求契约、实际 SDK 文件资源读取。

实际 Tesseract 容器测试识别合成图片 `Invoice 12345`。浏览器测试覆盖原管理界面、共享权限、MCP Apps 阅读/编辑/Bcc/确认链接/文件能力缺失/移动布局。实际 Keycloak 启用 introspection 后，验证有效登录与保留本地会话时 IdP 撤销导致 API 401；模板补充 introspection 客户端 audience，未绕过 active 或 audience 检查。

正式 Security diff scan 已完成：冻结差异 `7321d79..5a3f968` 审查 36 个源文件及全部 21 个配套变更，EWS 同类邮箱边界问题按 8 条可达操作分别记录（2 medium、6 low）。封存结果保留，随后修复全部操作并定向复审、回归；详见 [0.3 审查记录](review-0.3.zh-CN.md)。最终镜像 `sha256:254a864e8fb7bd3d32cad25ef9787c11a694c657bb0a97d899fce8125e78c1f2` 的实际 OCR 与空库 worker 启动/正常退出已验证。远程 CI 回执在推送后记录。以上测试不是实际 People/CardDAV/Exchange/Graph/Gmail 云账号验收。

## 配置和升级

完整操作步骤见 [0.3 运维说明](operations-0.3.zh-CN.md)。schema v3 增加共享授权并保护新密文格式，旧 0.2 程序启动时拒绝 v3；升级前必须停止旧 API/worker，不能混跑旧写节点。跨 schema 回退不得直接恢复旧发送台账快照，否则可能重发已被接受的邮件。

## 官方依据

- [People contacts](https://developers.google.com/people/api/rest/v1/people.connections/list)、[CardDAV RFC 6352](https://www.rfc-editor.org/rfc/rfc6352.html)。
- [EWS 邮箱操作](https://learn.microsoft.com/en-us/exchange/client-developer/exchange-web-services/how-to-work-with-exchange-mailbox-items-by-using-ews-in-exchange)、[Exchange Online EWS 退役与本地 Exchange 边界](https://techcommunity.microsoft.com/blog/exchange/exchange-online-ews-your-time-is-almost-up/4492361)。
- [Gmail draft replacement](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/update)、[Graph message update](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0)、[联系人授权](https://learn.microsoft.com/en-us/graph/permissions-reference#contactsreadshared)。
- [OpenAI 文件输入/可选文件库与结果约定](https://developers.openai.com/plugins/reference)、[MCP Apps 生命周期](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html)、[Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)。
