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
- [ ] 更新 README、实现矩阵、测试报告并推送 GitHub

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

## 后续增强（尚未实现，不能冒充真实账号验收问题）
- [ ] IMAP IDLE 连接池及 Gmail/Graph 推送通知（当前周期对账）
- [ ] Google People / CardDAV 与专用 EWS（按明确企业需求适配）
- [ ] Graph 主权云 / JMAP 跨源服务端配置
- [ ] 宿主原生文件交付和成熟 MCP Apps 阅读/编辑体验
- [ ] 原生草稿持续双向编辑同步、更多附件格式/OCR/附件全文索引
- [ ] 团队共享凭证权限、集中撤权 introspection、密钥轮换与定期保留清理

## 本轮 review 修复（均有代码与回归证据）
- [x] 发送确认显示并校验发件账号、附件字节身份；旧格式意图拒绝继续提交
- [x] JSONB 往返后摘要稳定；撤权和发送统一锁顺序
- [x] Gmail/JMAP 返信地址、Cc、Reply-To 与引用头；Gmail 字符集/HTML/内嵌 MIME 附件
- [x] Graph 完整正文与邮件头；IMAP 大邮件保持可列出
- [x] search 覆盖与续页、fetch 解码警告、网页账号切换延迟响应
- [x] 上传落库与撤权并发回归；实际 Keycloak 模板登录、sub 映射与权限声明验证
