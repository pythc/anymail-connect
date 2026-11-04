# 实施清单

每项分别记录代码和验证；勾选不代表真实邮箱或生产验收。外部验收保留独立清单。

## 底座
- [x] TypeScript 工程、锁定依赖、构建与 CI
- [x] PostgreSQL schema、迁移版本、事务、测试数据库
- [x] 凭证加密、账号/租户隔离、审计、撤权
- [x] OIDC/JWT 验证、网页登录会话、CSRF、受保护资源发现
- [x] 连接配置、OAuth 邮箱连接、token 刷新与安全网络出口
- [x] 标准 HTTP MCP、profile、search/fetch、分页和错误契约

## 邮件与适配器
- [x] IMAP/SMTP：查读、附件、文件夹、UIDVALIDITY、标记/移动/垃圾箱、发送
- [x] Gmail API：查读/线程/附件、标签、原生草稿、发送
- [x] Microsoft Graph：查读/附件、文件夹/分类、联系人、共享邮箱、发送
- [x] JMAP：会话发现、查读/附件、邮箱与提交
- [x] 应用草稿 CRUD、并发 revision、回复/全部回复/转发、显式原附件复制
- [x] 受保护附件上传/下载、HTML 清洗与大小限制
- [x] 发送意图、固定内容用户授权、持久幂等与未知状态不重试
- [x] 定时发送、取消竞争、worker、重启恢复
- [x] 批量读取/整理、部分失败、退订信息与 mailto 草稿
- [x] 增量/周期同步、游标/覆盖声明、缓存检索

## 产品与运维
- [x] 浏览器连接/查读/草稿/审批界面、来源链接
- [x] MCP Apps 可选预览资源与插件包装
- [x] 自托管容器、OIDC 配置示例、部署/备份/升级/回滚说明
- [x] 功能、权限、恢复、协议实验室、HTTP MCP 集成测试
- [x] 人工代码 review、依赖审计、Codex Security 扫描；确认页问题修复与回归（见 docs/review.zh-CN.md）
- [x] 更新 README、实现矩阵、测试报告并推送 GitHub（远程 main 已核验；CI 回执见 Actions）

## 外部验收：不能由本地模拟测试代替
- [ ] QQ / 163 / iCloud 真账号
- [ ] Gmail / Workspace 真账号与 OAuth 公共审核
- [ ] Outlook.com / Microsoft 365 / 共享邮箱真账号
- [ ] 企业品牌/内网/条件访问/别名实际环境
- [ ] JMAP / Proton Bridge / 本地 Exchange 实际环境
- [ ] ChatGPT web/desktop/mobile 安装、OAuth、附件/确认/UI/知识检索
- [ ] 生产压测、备份恢复、部署与回滚演练
- [ ] 公共目录审核与发布
- [ ] 项目拥有者确定许可证（当前 UNLICENSED）

## 扩展实施清单（勾选仅代表实现与本地证据）
- [x] IMAP IDLE 连接池、Gmail/Graph 鉴权推送、续期与持久合并队列（实际云推送仍待外部验收）
- [x] Google People / CardDAV 联系人与本地 EWS（Basic/Bearer、无 NTLM/自动发现；见 0.3 边界）
- [x] Graph 主权云端点/OAuth/刷新及 JMAP 管理员跨源白名单
- [x] 标准 MCP 文件资源/宿主文件输入、MCP Apps 阅读/编辑与能力缺失回退（真实宿主待验收）
- [x] Gmail/Graph 原生草稿持续同步与冲突/未知状态；Office/ODF/RTF/图片 OCR、显式附件全文索引
- [x] 同租户共享权限、逐请求 introspection、密钥环轮换与可配置保留清理

## 本轮 review 修复（均有代码与回归证据）
- [x] 发送确认显示并校验发件账号、附件字节身份；旧格式意图拒绝继续提交
- [x] JSONB 往返后摘要稳定；撤权和发送统一锁顺序
- [x] Gmail/JMAP 返信地址、Cc、Reply-To 与引用头；Gmail 字符集/HTML/内嵌 MIME 附件
- [x] Graph 完整正文与邮件头；IMAP 大邮件保持可列出
- [x] search 覆盖与续页、fetch 解码警告、网页账号切换延迟响应
- [x] 上传落库与撤权并发回归；实际 Keycloak 模板登录、sub 映射与权限声明验证

## 0.2.0 验证与交付
- [x] 实际 STARTTLS 正例、禁止明文降级、IDLE 事件与关闭实验
- [x] 批量通知租户/文件夹边界，重复合并与同步期间新事件保留
- [x] 租约过期进程写入拒绝，撤权/停机不领取新任务
- [x] schema v1→v2 重跑迁移与发送台账保留，更新版本回退门槛
- [x] 0.2.0 独立 review、Security diff scan 与修复（冻结版本 3 个低风险问题，修复后定向复核与回归）
- [x] 0.2.0 镜像/远程 CI 与推送回执（代码 `1eac64f`，Actions `41748193489` 全部成功）

## 0.3.0 逐项开发与交付
- [x] People 联系人 CRUD/分页与 Graph 只读/共享联系人授权
- [x] CardDAV 地址簿、href 出口约束、etag 写入与未知字段保留
- [x] 本地 EWS 指定邮箱、邮件/附件/文件夹/整理/发送与联系人 CRUD
- [x] 标准文件资源与权限复核、宿主文件输入的精确 origin 控制
- [x] MCP Apps 邮件阅读、草稿编辑、Bcc、确认链接、宿主能力回退
- [x] 原生草稿后台同步、双方变化冲突、未知结果停止与停用竞争
- [x] Graph 小文件附件写回/字节回读；大文件在写前显式拒绝
- [x] 更多附件格式、离线图片 OCR 与显式私有索引/检索/删除
- [x] 共享授权/降权/到期/撤销，私有草稿/上传与旧发送审批失效
- [x] API/MCP/网页在线 token 检查与实际 IdP 撤销实验
- [x] 带 key ID 的密钥环、旧密文读取、轮换 dry-run/apply/重跑
- [x] 保留策略展示与清理、活动引用保护、发送台账保留
- [x] schema v1/v2→v3 迁移/重跑、拒绝旧二进制回退的门槛
- [x] 0.3.0 正式差异扫描、审查修复、最终回归与镜像验证（见 docs/review-0.3.zh-CN.md）
- [x] 0.3.0 推送与远程 CI 回执（代码 `71b4ec2`，Actions `41764190975` 全部成功；见 docs/review-0.3.zh-CN.md）

可开发条目不再与外部验收混列。服务商协议的具体限制见 docs/release-0.3.zh-CN.md；勾选不表示任意品牌、认证方式、文件格式或宿主均已获认证。
