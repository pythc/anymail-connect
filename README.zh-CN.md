<p align="right"><a href="README.md">English</a> · <strong>简体中文</strong></p>

![多种邮件连接汇聚到统一接入层](assets/cover.jpg)

<h1 align="center">AnyMail Connect</h1>
<p align="center">面向个人与企业邮箱的、自托管的 MCP 邮件后端。</p>
<p align="center"><a href="docs/architecture.md">架构</a> · <a href="docs/deployment.md">部署</a> · <a href="docs/providers.md">服务商</a> · <a href="docs/api.md">接口</a></p>

AnyMail Connect 将 Gmail、Microsoft Graph、IMAP/SMTP、JMAP 和受管理员批准的本地 Exchange EWS 接到同一个权限与操作层。MCP 客户端负责交互；后端负责邮箱授权、能力声明、持久草稿、同步、附件及有明确授权的发送。

**开发版本。** 不捆绑邮箱管理前端，也不承诺所有邮箱具有相同功能。浏览器仅承担服务商 OAuth、受保护的来源查看，以及逐封、固定内容的发送确认。企业策略、服务商权限和 MCP 宿主能力仍需分别验收。

## 后端能力

- **统一入口**：Streamable HTTP MCP、相同工具注册表的 HTTP 接口、来源引用与鉴权附件资源。
- **保留服务商语义**：标签与文件夹、搜索范围、原生草稿、联系人及委派共享邮箱按适配器实际能力提供。
- **显式授权**：OIDC 身份、租户和账号隔离、读/写/发送 scope、同租户共享授权与撤权。
- **持久工作流**：草稿 revision、固定内容发送审批、幂等台账、定时任务和未知结果停止；不自动重发不确定提交。
- **独立 worker**：同步游标、周期对账、IMAP IDLE、鉴权 Gmail/Graph 通知、原生草稿冲突处理和保留清理。
- **附件处理**：受限提取、可选离线 OCR、显式私有索引；索引覆盖不等于全邮箱覆盖。

## 适配范围

| 接入方式 | 个人与企业场景 | 主要约束 |
| --- | --- | --- |
| Gmail API + People | Gmail、启用 Gmail 的 Workspace | 用户 OAuth、应用审核与组织策略 |
| Microsoft Graph | Outlook.com、Microsoft 365、委派共享邮箱 | 租户同意、实际共享权限和条件访问 |
| IMAP + SMTP | 开放标准协议的邮箱、自建服务、兼容 Bridge | TLS、服务商授权码/密码、服务器扩展 |
| JMAP | 启用 JMAP 的服务 | 会话地址、API 令牌、管理员跨源白名单 |
| EWS | 获批准的本地 Exchange | 指定 HTTPS 端点、Basic/Bearer；无 NTLM/自动发现 |

可选 CardDAV 为已连接账号补充指定地址簿。[服务商配置和能力边界](docs/providers.md)以实现为准；协议测试不等于对每个品牌和企业部署的认证。

## 开始部署

需要 Node.js 24+、PostgreSQL 和独立 OIDC 身份服务。邮箱服务商 OAuth 与 AnyMail 登录 OIDC 分别配置。

```sh
git clone https://github.com/pythc/anymail-connect.git
cd anymail-connect
cp .env.example .env
```

按[部署文档](docs/deployment.md)填写密钥、身份与邮箱配置，再启动：

```sh
docker compose build
docker compose up -d
```

MCP 地址为 `BASE_URL/mcp`，OAuth 邮箱连接页面为 `BASE_URL/connect`。根路径返回服务信息 JSON。消费者通过 MCP 或 HTTP 接口查读、管理草稿与提交工作流。

发送流程为：**创建草稿 → 固定 revision 准备发送 → 用户打开 `approval_url` 核对并批准 → worker 提交**。服务商接受不代表最终投递；unknown 状态须对账，不自动重发。

## 开发与文档

```sh
npm ci
npm run check
npm run build
```

仓库保留合成回归测试、协议夹具与 CI。真实账号凭证、邮箱内容、验收令牌、个人开发清单、构建输出和测试报告不属于公开源码。英文文档提供[架构](docs/architecture.md)、[HTTP/MCP 接口](docs/api.md)、[部署](docs/deployment.md)、[服务商配置](docs/providers.md)、[升级/备份/密钥轮换](docs/operations.md)和[贡献指南](CONTRIBUTING.md)。

当前为 `UNLICENSED`；公开可见不等于授予开源再分发许可。项目不隶属于 OpenAI、Google 或 Microsoft。封面由 OpenAI 图像生成工具制作。
