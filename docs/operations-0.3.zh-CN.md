# 0.3 运维与能力配置

## 联系人和本地 Exchange

Gmail OAuth 新连接按只读/可写分别请求 contacts.readonly/contacts。Graph 请求对应 Contacts.Read/ReadWrite；共享邮箱使用相应 `.Shared` 委派权限。旧连接须重新授权，实际批准仍由服务商/企业管理员控制。

任一连接对象可增加 `carddav`：`{"url":"https://dav.example/addressbook/","username":"user","password":"app-password"}`。URL 必须为显式地址簿并以 `/` 结尾；凭证与邮箱连接一起加密。联系人接口为 `provider_extension` 的 `contacts.*`，更新/删除 CardDAV 需最近读取的 `etag`。未给出的联系人字段保留；给出的地址/电话数组表示替换该集合。

本地 Exchange 先设置 `EWS_ALLOWED_ORIGINS=https://exchange.example`，企业内网另配置 `PRIVATE_ENDPOINTS=exchange.example:443`；不能以 origin 白名单代替网络目的地检查。在管理页高级 JSON 连接中使用：

```json
{"provider":"ews","email":"user@example.com","url":"https://exchange.example/EWS/Exchange.asmx","auth":{"type":"basic","username":"DOMAIN\\user","password":"app-password"}}
```

预置 OAuth 令牌可用 `auth:{"type":"bearer","token":"..."}`；不自动刷新企业自定义 STS 令牌。Basic 必须由服务器管理员明确允许且只经证书验证的 TLS。NTLM/Kerberos、自动发现与 Exchange Online EWS 不在当前适配范围。EWS SOAP 响应最多 12 MiB，XML 层数/条目限制有效；联系人最多 3 个邮箱和 2 个商务电话。`Search.query` 使用 EWS AQS，暂不与结构化过滤混合；文件夹列表为根目录浅层前 100 条。

## 团队授权与 token 检查

由连接所有者在管理页配置共享，或显式调用 `accounts_grant`。`subject` 是同一可信 IdP/租户的不可变 ID，不是显示名或邮箱地址。读权限包含邮件和已连接通讯录；写/发送还受连接本身的 writable/sendEnabled 限制。新用户不获得凭证明文、连接撤销或推送管理权限。每位使用者有私有应用草稿、上传与附件索引；服务商原生草稿是共享邮箱内容，邮箱读权限使用者可以读取。发送授权绑定该使用者，收回/降权/到期后旧审批不会在重新授权时复活。

`OIDC_INTROSPECTION=true` 后，每次 API/MCP 请求与浏览器会话使用都先验证 JWT，再由配置 IdP 确认 active，并收窄 scope。配置相同 issuer origin 的 introspection endpoint 和可用的保密客户端认证。Keycloak 模板向签发 token 增加 `anymail-web` audience，使此服务的保密客户端能 introspect 已含资源 audience 的 token；资源 audience、issuer、sub、client 验证仍保留。

启用时，旧会话若没有封存的 access token 会要求重新登录。故障/失效 token 不回退离线放行。注销网页会话/使 token 失效不自动取消已持久批准的定时发送或已明确启用的原生草稿自动写回；要取消这些操作，应收回共享权限、撤销邮箱连接或显式取消发送。

## 原生草稿、附件与宿主

在原生草稿面板输入 Gmail draft ID 或 Graph draft message ID；导入会建立新应用草稿和私有绑定。后台每分钟处理到期绑定，默认只拉取，自动写回需单独勾选。冲突/unknown 先通过 `native_drafts_inspect` 只读获取双方内容和最新版本，保留停止状态，再在界面作显式选择；远端版本再次变化则拒绝旧选择。停止关联不会删除任一草稿；已经发出的远端写入无法保证召回。未知结果/崩溃中断不会自动重放。

Gmail 替换 MIME 前检查版本，但服务商未提供已核实的原子 CAS；与原生客户端同时编辑仍可能竞争。Graph 更新正文/收件人并带版本条件头；小于 3MB 的文件附件变化按删除/添加流程同步，并回读字节摘要；多步操作中断会停为 unknown，不自动重试，应用草稿保留。更大附件需上传会话，当前明确拒绝。实际版本条件、并发和租户策略须真账号验收。IMAP/JMAP/EWS 不用非原子替换伪装原生草稿同步。

`attachments_export` 返回标准资源链接，可通过当前用户鉴权的 MCP resources.read 读取；管理网页仍提供鉴权下载。宿主必须支持该标准。`attachments_import_file` 的文件 schema 声明 `download_url/file_id/mime_type/file_name`，仅前两个必填。配置 `HOST_FILE_ORIGINS` 为实际宿主提供的精确 HTTPS 下载 origin；不要设置通配符或接受模型传入的 origin。下载不携带服务商凭证，不跟随重定向，最多 5 MiB。可选宿主文件库不可用时，界面提示使用管理页上传。

`attachments_read` 可选 `ocr:true`；`attachments_index` 显式保留所选附件的文本快照，`attachments_search` 只检索当前使用者已索引范围，`attachments_unindex` 删除快照。缓存和索引是服务端受权限控制的明文数据；生产数据库/备份的磁盘加密与访问控制由部署方配置，凭证加密不能代替这些措施。

## OCR 与保留

容器含 Tesseract 和英/简中语言包。设置 `OCR_ENABLED=true`、`OCR_LANGUAGES=eng+chi_sim` 才允许显式 OCR；只接受 PNG/JPEG，最多 1600 万像素。单 API 进程最多一笔 OCR，子进程单线程、6 秒截止、输出上限，Linux 额外限制 512MiB 地址空间，外层解析 worker 仍有时间/堆限制。此机制不是恶意文件 OS 沙箱；高风险多租户环境应另作进程/容器隔离与资源预算。没有扫描 PDF 渲染 OCR。

worker 默认清理 30 天前缓存/索引；`RETENTION_DRAFT_DAYS`（草稿/上传）和 `RETENTION_AUDIT_DAYS` 默认 0，表示不自动删除，管理员按个人/企业策略显式配置。开启后每账号每轮最多删除 1000 条；活动/未知发送引用、启用的原生绑定和草稿附件被保护，旧数据没有时间戳时保留。发送台账及幂等键不清理，避免历史操作被重新提交。`data_policy` 与网页显示当前策略。

## 升级、密钥轮换与回退

1. 停止领取新发送，等待在途操作进入明确或 unknown 状态；停止全部旧 API/worker。备份数据库并独立保存对应密钥，核对发送台账。
2. 部署全部 0.3 节点。schema v3 使用事务/锁迁移，保留旧凭证、草稿和发送台账；0.2 启动拒绝 v3，已运行的旧进程必须事先停掉。
3. 轮换时，新 key 使用唯一 `ENCRYPTION_KEY_ID`，在 `ENCRYPTION_KEY` 配置新的 32-byte base64 key，并用私密 JSON `ENCRYPTION_PREVIOUS_KEYS` 提供旧 ID→旧 key。不要重用 ID 或把真实密钥写进仓库。
4. 所有 API/worker 都切到相同密钥环并确认无旧写节点后，运行 `npm run rotate-keys` 做 dry-run；它验证所有现有密文，包括标记为当前 key 的密文。再运行 `npm run rotate-keys -- --apply`，按账号锁迁移账号/push/session。可重跑，不输出明文或密钥；失败时保留旧密钥后修复并续跑。
5. 再次 dry-run 确认旧密文计数为零，验证实际账号/会话后才从在线环境移除旧 key。旧备份恢复仍需要对应旧 key，不能同步销毁备份密钥。
6. 回退仅限同样支持 schema v3/新密文与当前密钥环的已验证程序。跨 schema 回退须隔离演练、受控转换和发送台账对账；不得把旧 operations 快照直接恢复到可发送环境。

EWS 对象标识使用账号/邮箱/端点和类型绑定的服务器 MAC。轮换期间保留旧 key 可继续读取旧标识；最终移除旧 key 后，旧 EWS 来源链接、缓存或附件索引中的标识会失效，应重新搜索/同步/索引。邮箱/端点或连接身份变化同样需要重新取得标识；不接受手填原始 Exchange ItemId。

这些步骤是可执行程序与操作门槛；真实生产备份恢复、压测、跨版本回退仍需独立验收。
