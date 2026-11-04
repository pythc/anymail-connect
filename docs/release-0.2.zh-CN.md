# 0.2.0 即时同步与企业接入

日期：2026-11-04。开发版本；真实邮箱、云推送、公网部署和 ChatGPT 安装仍待外部验收。

## 已实现

- 有界 IMAP IDLE 池：默认每 worker 8 条，数据库租约协调账号，续租、错误退避、20 分钟轮转、撤权和停机关闭。监听 INBOX；不支持 IDLE 时保留周期对账。
- Gmail Pub/Sub：受签名 JWT、issuer/audience/service-account email/email_verified/期限约束的回调，原生 watch/stop 和续期。
- Graph：基础通知的 validationToken、订阅 ID/随机 clientState 验证、创建/续期/停止、生命周期提示与注册结果不确定后的对账路径。委派共享邮箱推送显式不支持。
- 独立持久 `change_requests` 队列：同账号/文件夹信号合并，批量账号锁与租户/主体校验，失败退避，分页持续同步。新信号到达会改变 token，旧任务结束时不会删除新任务。
- 发送、通知消费、推送续期、周期对账和 IDLE 续租分别调度；慢邮箱不阻塞全部工作类型。停机停止领取后续任务，发送未知结果不重试的规则保留。
- Graph global/usgov/usgovdod/china 的静态 API、授权与 token 刷新端点；OAuth state 保留所选云，旧凭证默认 global。
- JMAP API/上传/下载跨源只能由管理员精确配置 HTTPS origin；原有网络目的地与 TLS 校验继续生效。新增 JMAP 网页连接表单。
- 网页推送配置/状态及 MCP `notifications_status`；账号范围授权，状态不返回 clientState、密文或 lease token。worker 分配不代表远端握手完成，通知不会主动启动 AI 对话。

## 升级与回退

schema v2 在事务内增加队列表与索引，保留 v1 的凭证、草稿和发送台账。迁移可重跑；0.1.0 会拒绝读取 v2，避免把主权云凭证误用于全球端点。支持 v2 的镜像之间可按部署文档回滚；跨 schema 回退需要隔离演练和发送台账对账，不能直接恢复旧 operations 快照。

## 当前证据

- 本机 `npm run check` 102 项通过；同一套测试在独立 PostgreSQL 17 上 102 项通过，0 失败/跳过。
- 实际 STARTTLS 的 IMAP/SMTP 登录与发送；没有 STARTTLS 时拒绝登录、拒绝发送；IDLE 收到真实协议服务器 EXISTS 并在 abort 后关闭。
- Pub/Sub 本地 RSA 签名正反例、Graph clientState/订阅映射、重复通知、同步期间新事件、批量文件夹/租户边界、过期续期 lease、撤权及停机。
- Graph 四个云环境的 OAuth/刷新/API 契约与状态；JMAP 跨源精确白名单拒绝与放行契约。
- v1→v2 重跑迁移，旧凭证/草稿/发送台账保留，更高 schema 拒绝启动。
- 桌面/移动浏览器交互、推送状态、JMAP 合成连接与令牌表单清理通过。

新增公开 webhook 等改动已完成独立复核和 Security diff scan：冻结提交 `149a4a1` 发现 3 个低风险问题，随后完成修复、定向复审和回归；详见 [审查记录](review-0.2.zh-CN.md)。握手中途取消、实际 15 秒期限、400 个事件期间最多一笔写入、只读令牌拒绝启停、只读邮箱配置及失败续期回调连续性均有新增测试。正式扫描针对修复前冻结版本；修复后未声称执行第二次完整扫描。

最终源码的本地镜像 `anymail-connect:validation-0.2` 构建成功，image ID 为 `sha256:3f2e35cb205550b74beac0d3c1f059f9f4c5ff096455fc136eae7fc98d5f6484`。在隔离 PostgreSQL 测试库启动生产 worker，无真实账号、IDLE=0，SIGTERM 后退出码 0；实际 Keycloak 登录检查通过。本地镜像没有发布或部署到公网。

功能提交 `149a4a1` 与修复提交 `1eac64fba3e49f17e8b3faec0ef01fd9f3739613` 已推送公开 [pythc/anymail-connect](https://github.com/pythc/anymail-connect)，远程 main 回读一致。[CI run 41748193489](https://github.com/pythc/anymail-connect/actions/runs/41748193489) 的 `check` 与 `browser` 均为 success：Linux 上 PGlite/PostgreSQL 各 102 项、构建、格式、依赖审计（0 漏洞）、桌面/移动浏览器与实际 Keycloak 登录全部通过。后续仅回执文档提交的精确 SHA 与状态见 Actions，不把代码提交回执冒充后续提交的结果。

## 仍需验收

公网 Gmail Pub/Sub IAM、实际云签名和推送、Microsoft 各云租户与共享策略、真实邮箱 IDLE/断线、生产负载/恢复/升级回滚、ChatGPT 安装与文件/UI 均未完成。实现了通知协议和本地证据，不等于这些外部系统已配置或通过验收。

剩余联系人/企业专用协议、团队共享凭证、introspection、密钥轮换/保留、原生草稿双向同步和宿主文件/UI 增强仍见 [TODO](../TODO.md)。操作配置及官方依据见 [部署文档](deployment.zh-CN.md)。
