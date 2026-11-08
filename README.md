# TokenTally · 大模型 API Key 费用分析（阿里云百炼 + 腾讯云 TokenHub）

面向企业的 **多云大模型 API Key 级费用与用量综合分析系统**。通过只读访问密钥定时同步 **阿里云百炼（Model Studio）** 与
**腾讯云大模型服务平台 TokenHub** 的 API Key、业务空间、用量与费用中心账单，永久保存到 SQLite，围绕
“每个 API Key / 每个部门花了多少、花在哪、是否合理、会不会超支”提供成本管理、预算告警、成本中心分摊与模型调用的深度分析。

- **交付形态**：`docker compose` 一键部署，对外是一个带登录的网址；可选 Caddy 自动 HTTPS；支持品牌定制、自动备份、Prometheus 监控
- **零第三方依赖**：Node.js 24 内置 `node:http` + `node:sqlite` + `node:crypto`，无 npm 包，供应链攻击面最小
- **口径与云厂商一致**：按账期查询用费用中心**月度账单**，按日期查询用**按天账单**，自然日按北京时间划分；签名算法内置官方示例自检

---

## 功能

| 模块 | 回答的问题与内容 |
|---|---|
| **成本概览** | 本期花了多少、是否正常、会不会超预算、变化来自哪里：本期费用（应付/原价/优惠后可切换）与环比、预算使用率与**月末预测**、每百万 Token 成本、缓存命中率；费用趋势（每日堆叠 / 本期与上期**累计对比** + 月末预测 / 近 12 个账期，可按 Key、模型、业务空间、**云厂商**、**成本中心**分组）；**关键发现**；Key / 模型排行、费用构成、变动归因、治理摘要；点击每日柱下钻到当日明细 |
| **API Key 分析** | 全部 Key（两家云厂商、含已删除仍有账单的 Key）的云厂商、描述、业务空间、**成本中心 / 负责人**、状态、费用与环比、占比、预算使用、Token、缓存命中率、单位成本、**请求数与失败率**（腾讯云）、主要模型、最近消费、权限与 IP 白名单；**批量归属设置**；Key × 日期消耗热力 |
| **Key 详情页** | 单个 Key 的费用与排名、Token、单位成本、命中率、请求次数、预算/预测；成本中心、负责人、备注（可编辑）；每日费用、模型构成、近 12 个账期、计费维度、模型明细（含请求数 / 失败率）、计费项明细、调用渠道、权限与变更历史；腾讯云 Key 标注“按用量分摊” |
| **模型分析** | 模型费用、所属云厂商、Token 结构、命中率、输出/输入比、单位成本、计费维度、每日费用、Key × 模型矩阵、模型 × 计费项 × 单价；模型详情抽屉 |
| **成本分摊** | 多维透视：行/列任选 **云厂商、成本中心、负责人**、业务空间、API Key、模型、Token 类型、计费项、计费时段、渠道、日期、**自然周、星期**、近 12 月；指标可选费用/原价/Token；数值或占比、色阶；常用预设（成本中心 × 模型、成本中心 × 近 12 月等）；单元格下钻到账单明细；导出 CSV、**打印 / 另存 PDF** |
| **账单明细** | 逐条账单（标注云厂商与“分摊 / 估算”口径），导出 CSV 含全部字段 |
| **Key 治理** | 已删除/已禁用仍计费、超出/预计超出预算、费用突增、有消费无描述、**未分配成本中心**、权限过宽、闲置 30 天、未限制 IP、未归属业务空间；分级并给出处置建议 |
| **变更记录** | 两家云厂商同步时检测到的 API Key / 业务空间新增、修改、删除、恢复 |
| **系统管理** | 阿里云接入、**腾讯云接入**、数据同步（按云厂商）、预算管理、**告警通知**（多渠道）、用户管理、**品牌与备份**、安全与审计、接口日志 |

全局：账期 / 日期两种口径，筛选（云厂商、业务空间、API Key、模型、成本中心、Token 类型、计费项、渠道、关键字），费用口径切换，
浅色 / 深色 / 跟随系统主题，页面地址可收藏分享（如 `#/key/171769`），键盘 `/` 聚焦搜索，所有表格支持排序、首列冻结、紧凑模式与 CSV 导出。

### 多云：腾讯云 TokenHub 的 Key 级费用怎么算

腾讯云计费中心的账单按 **推理服务 / 模型** 出账，**不含 API Key 维度**。系统同时拉取：

1. 计费中心账单明细 `DescribeBillDetail`（真实金额，含折扣、代金券）
2. TokenHub 用量统计 `DescribeUsageRankList`（每个 API Key × 模型 × 日 的输入 / 缓存命中 / 输出 Token 与请求数）

**Key 费用 = 当日该模型同一计费项的账单金额 × 该 Key 在当日该模型对应 Token 中的占比**（输入按“输入 − 缓存命中”、缓存命中按缓存 Token、输出按输出 Token），
最后一份取余数，**所有 Key 合计与腾讯云账单分毫不差**；当日找不到用量时回退到整月用量占比；账单资源本身就是 API Key 时直接归属。
页面上这类费用标注“分摊”。若 CAM 子用户缺少计费只读权限，可选按 TokenHub 模型目录价 × 用量**估算**（标注“估算”，不含折扣与阶梯价，获得权限后自动替换为真实账单）。

### 告警通知与报表推送

在“系统管理 → 告警通知”中配置最多 5 个渠道（**钉钉 / 飞书 / 企业微信群机器人、通用 Webhook**），每个渠道单独订阅事件：

| 事件 | 触发条件 | 去重 |
|---|---|---|
| 预算告警 | 总预算 / 单个 Key 预算达到预警阈值、超出预算、预计月末超出总预算 | 同一阈值每账期每渠道一次 |
| 费用异常 | 昨日费用 ≥ 前 7 日日均 × 倍数（默认 2）且增量 ≥ 最小金额（默认 ¥50），整体与单个 Key | 每天一次 |
| 同步故障 | 同一云厂商同类同步连续失败 3 次；恢复后发送恢复通知 | 每次故障一次 |
| API Key 变更 | 新增 / 删除 / 恢复 API Key（安全治理） | 每条变更一次 |
| 日报 / 周报 / 月报 | 每天设定时间（默认 9:00）后：昨日费用与环比、本月累计与预测、Top Key / 模型、异常；周一发上周周报；次月出账后发月报（含成本中心分摊） | 每周期一次 |

- 告警可 **@ 手机号 / @所有人**（钉钉支持手机号；飞书自定义机器人仅支持 @所有人；企业微信会追加一条带 @ 的文本消息）
- 钉钉、飞书支持加签；通用 Webhook 配置密钥后附带 `X-Alert-Timestamp` 与 `X-Alert-Signature: sha256=HMAC(secret, timestamp + "." + body)`
- 某个渠道发送失败不影响其他渠道，失败项下次检查时自动重试；报表可在页面预览并立即发送
- Webhook 地址与密钥加密保存且不回显；仅允许 HTTPS，钉钉/飞书/企业微信只允许官方域名，连接时拒绝解析到内网/保留地址的目标（防 SSRF / DNS 重绑定）
- 消息标题带品牌名称；设置 `PUBLIC_URL` 后附带“打开费用分析”链接

### 成本中心与负责人

在“API Key 分析 → 归属设置”中为 Key 批量设置 **成本中心、负责人、备注**（本地标签，不修改云厂商上的 Key）。之后可按成本中心筛选、
在概览中按成本中心查看构成与趋势、在成本分摊中做“成本中心 × 模型 / 近 12 月”透视，月报自动附带按成本中心的分摊，治理页提示有消费但未分配成本中心的 Key。

## 部署

需要一台能访问 `*.aliyuncs.com` / `*.tencentcloudapi.com` 的 Linux 服务器，已安装 Docker 与 Docker Compose v2。完整的部署、HTTPS、备份恢复、升级与监控说明见
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

```bash
cp .env.example .env
```

```bash
chmod 600 .env
```

编辑 `.env`，至少填写主密钥（用于加密访问密钥，请单独妥善保管）：

```bash
openssl rand -base64 32
```

把输出填入 `APP_MASTER_KEY=`，然后启动：

```bash
docker compose up -d --build
```

查看初始管理员密码（未设置 `ADMIN_PASSWORD` 时随机生成，首次登录强制修改）：

```bash
docker compose logs app | grep 初始管理员密码
```

浏览器打开 `http://服务器IP:8080` 登录后：

1. **系统管理 → 阿里云接入**：填写 RAM 用户 AccessKey，“测试已保存配置”确认 5 项接口通过
2. **系统管理 → 腾讯云接入**：填写 CAM 子用户 SecretId / SecretKey，测试 5 项接口
3. **数据同步**：回溯账期数调为 12 并“全量回溯”；**预算管理**设置预算；**告警通知**添加群机器人；**API Key 分析 → 归属设置**分配成本中心

只使用其中一家云厂商时，只配置对应的接入即可，界面会自动隐藏云厂商维度。

## 权限（只读）

**阿里云 RAM**：系统策略 `AliyunBailianReadOnlyAccess` + `AliyunBSSReadOnlyAccess`，或最小权限自定义策略：

```json
{
  "Version": "1",
  "Statement": [
    { "Effect": "Allow", "Action": ["modelstudio:ListWorkspaces", "modelstudio:ListApiKeys", "modelstudio:GetApiKey", "modelstudio:GetBillingOverview", "modelstudio:GetBillingTrend"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["bss:DescribeInstanceBill", "bss:QueryBillOverview"], "Resource": "*" }
  ]
}
```

**腾讯云 CAM**：为本系统创建仅编程访问的子用户，授予 TokenHub 只读与费用中心账单只读权限，或参考以下自定义策略（以 CAM 控制台策略语法为准）：

```json
{
  "version": "2.0",
  "statement": [
    { "effect": "allow", "action": ["tokenhub:DescribeApiKeyList", "tokenhub:DescribeModelEndpointList", "tokenhub:DescribeUsageRankList", "tokenhub:DescribeModelList"], "resource": ["*"] },
    { "effect": "allow", "action": ["finance:DescribeBillDetail", "finance:DescribeBillSummaryByProduct"], "resource": ["*"] }
  ]
}
```

## 数据来源与口径

| 云厂商 | 数据 | 接口 | 同步策略 |
|---|---|---|---|
| 阿里云 | 业务空间、API Key、描述、权限、IP 白名单 | ModelStudio `ListWorkspaces` / `ListApiKeys`（2026-02-10） | 默认每 5 分钟，记录变更 |
| 阿里云 | 账期 / 按日账单 | BssOpenApi `DescribeInstanceBill` · MONTHLY / DAILY · 按计费项 | 默认每 60 分钟；已出账账期同步一次后定稿；最近 3 天每次刷新 |
| 阿里云 | 对账 | ModelStudio `GetBillingOverview` | 随账单同步 |
| 腾讯云 | API Key、名称、备注、状态、绑定模型 / 接入点、IP 白名单 | TokenHub `DescribeApiKeyList`、`DescribeModelEndpointList`（2026-03-22） | 默认每 5 分钟，记录变更 |
| 腾讯云 | Key × 模型 × 日 用量与请求数 | TokenHub `DescribeUsageRankList`（apikey_usage） | 随账单同步（用量统计最长约 90 天） |
| 腾讯云 | 账单明细 | 计费 `DescribeBillSummaryByProduct` 识别产品代码 + `DescribeBillDetail`（2018-07-09） | 默认每 60 分钟，按账期整体替换并拆分到日 |

- 阿里云实例ID解析：`ApiKeyID;业务空间ID;模型;计费项;[调用渠道];[免费额度用完即停]`，计费项如 `input_token_cache_peak` 解析为“输入 · 缓存命中 · 峰时”。
- 腾讯云账单按“日 × 资源 × 模型 × 计费项 × 单价”合并（按量计费按小时出账），模型名来自推理服务 → 模型映射；计费项名称映射为输入 / 缓存命中 / 输出 / 思考。
- **应付金额** = 原价 − 优惠 − 优惠券抵扣（税前）；腾讯云对应 `RealCost`。可切换为原价或优惠后金额。
- 环比：历史账期对比上月全月；当月对比“上月同期”；按日期查询对比上一个等长周期。账单相对实际调用约延迟数小时，次月 3 日后出账为准。

## 安全措施

| 层面 | 措施 |
|---|---|
| 凭证 | 阿里云 AccessKey、腾讯云 SecretKey、Webhook 地址与密钥以 **AES-256-GCM** 加密后存入 SQLite（AAD 绑定字段名），只写不回显；主密钥来自环境变量 `APP_MASTER_KEY`，与数据卷分离 |
| 签名 | 阿里云 ACS3-HMAC-SHA256、腾讯云 TC3-HMAC-SHA256 启动时用官方文档示例自检，失败拒绝启动；后端只开放只读接口白名单 |
| 账号 | 密码 scrypt（N=32768）哈希；至少 10 位且含字母与数字；首次登录/重置后强制改密；改密后其他会话失效 |
| 敏感操作 | 更换任一云厂商访问密钥、下载数据备份须再次输入当前登录密码；连续输错 5 次强制退出该用户全部会话并记录审计 |
| 登录防护 | 单用户连续 5 次失败锁定 15 分钟；单 IP 15 分钟内最多 20 次失败；统一错误提示与等时校验 |
| 会话 | 随机 256 位令牌（库中仅存哈希）；HttpOnly + SameSite=Strict（HTTPS 下 Secure + `__Host-` 前缀）；空闲 2 小时 / 最长 12 小时过期 |
| 请求 | CSRF 令牌 + Origin 校验；严格 CSP（禁止内联脚本）、X-Frame-Options、nosniff、Referrer-Policy、HSTS、`X-Robots-Tag: noindex`；请求体大小与频率限制；可选 IP 白名单 `ALLOW_CIDRS` |
| 外发请求 | 告警 Webhook 仅 HTTPS、官方域名白名单、连接阶段拦截内网 / 保留地址（防 SSRF 与 DNS 重绑定）、8 秒超时、响应大小限制 |
| 监控接口 | `/metrics` 需 Bearer 令牌（≥16 位，未配置则关闭），独立限流，不含任何密钥与 Key 描述 |
| 审计 | 登录、配置与密钥变更、二次验证失败、预算、成本中心标签、告警配置与发送、备份创建与下载、用户管理、同步触发全部写入审计日志 |
| 容器 | 非 root（uid 1000）、只读根文件系统、`cap_drop: ALL`、`no-new-privileges`、内存/CPU/进程数限制、健康检查、日志轮转 |

## 运维

- **自动备份**：每天 `BACKUP_HOUR`（默认 3 点）在数据卷 `/data/backups` 生成一致性备份，保留最近 `BACKUP_KEEP`（默认 7）份；管理页可立即备份、验证密码后下载
- **健康检查**：`GET /healthz`（存活）、`GET /readyz`（数据库可用）
- **监控**：设置 `METRICS_TOKEN` 后 `GET /metrics`（Prometheus 文本格式）：各云厂商同步状态与最近成功时间、本月应付金额、预算使用率、Key 数量、告警渠道状态、会话数
- **升级**：`git pull && docker compose up -d --build`，数据库自动迁移（v1.1 → v1.2：多云字段、用量表、成本中心标签；单渠道告警配置自动转换为多渠道）

恢复备份、忘记管理员密码、Prometheus 抓取配置等见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_MASTER_KEY` | — | 加密主密钥，**必填**，≥32 字符 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / 随机 | 仅在没有任何用户时创建 |
| `HTTP_PORT` / `BIND_ADDR` | 8080 / 0.0.0.0 | 对外端口与绑定地址 |
| `TRUST_PROXY` | false | 位于反向代理之后时设为 true |
| `COOKIE_SECURE` | auto | auto / true / false |
| `DOMAIN` | — | `https` profile 使用的域名 |
| `ALLOW_CIDRS` | — | IP 白名单，逗号分隔 |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | 120 / 12 | 会话超时 |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` / `LOGIN_MAX_PER_IP` | 5 / 15 / 20 | 登录防暴力破解 |
| `BILL_TZ` | Asia/Shanghai | 账单自然日时区 |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` / `_SECRET` | — | 可选，首次启动导入阿里云 AccessKey 后加密存库，建议之后从 `.env` 删除 |
| `TENCENTCLOUD_SECRET_ID` / `_KEY` | — | 可选，首次启动导入腾讯云 API 密钥后加密存库 |
| `PUBLIC_URL` | — | 可选，对外访问地址，用于告警消息中的跳转链接 |
| `ALERT_ALLOW_PRIVATE` | false | 允许通用 Webhook 指向内网地址（仅在接收端位于内网时开启） |
| `BACKUP_KEEP` / `BACKUP_HOUR` | 7 / 3 | 自动备份保留份数（0 关闭）与时间 |
| `METRICS_TOKEN` | — | 可选，≥16 位，开启 `/metrics` |
| `TENCENT_ENDPOINT_OVERRIDE` | — | 仅用于测试或私有 API 网关，生产环境请留空 |

## 目录结构

```
├── docker-compose.yml   # app + 可选 caddy(https)
├── Dockerfile
├── Caddyfile
├── .env.example
├── docs/DEPLOYMENT.md   # 部署与运维手册
└── app
    ├── src
    │   ├── server.mjs   # HTTP、鉴权、会话、CSRF、限流、路由、备份、指标
    │   ├── sync.mjs     # 多云定时同步（元数据 / 账单 / 用量 / 分摊 / 对账）
    │   ├── aliyun.mjs   # 阿里云 ACS3-HMAC-SHA256 客户端、账单实例ID解析
    │   ├── tencent.mjs  # 腾讯云 TC3-HMAC-SHA256 客户端、账单解析、按用量分摊、目录价估算
    │   ├── alerts.mjs   # 多渠道告警、费用异常、同步故障、日/周/月报（加签、SSRF 防护）
    │   ├── db.mjs       # SQLite 结构、迁移与读写
    │   ├── calllog.mjs  # 云 API 调用日志（内存）
    │   ├── crypto.mjs   # scrypt、AES-256-GCM、主密钥
    │   └── config.mjs
    └── public           # 前端（原生 ES 模块，无外部 CDN 与构建步骤）
        ├── index.html / login.html / app.css
        └── js
            ├── main.js        # 路由、导航、周期、筛选、同步状态、用户菜单、主题
            ├── core.js        # 状态、格式化、账单解析与聚合、维度、预测与预算、对话框
            ├── charts.js      # 柱/线/排行/发散/分段/热力等 SVG 组件
            ├── table.js       # 表格（排序、分页、首列冻结、键盘、CSV 防公式注入）
            ├── insights.js    # 关键发现规则
            └── views/         # overview · keys · key · day · models · pivot · detail · governance · changes · admin
```

`/api/data` 按数据版本返回 ETag，数据未变化时 304，页面刷新/轮询不重复传输。
预算按自然月的应付金额（多云合计）计；月末预测 = 已完成日合计 + 今日已入账 + 已完成日日均 × 剩余天数。

不使用 Docker 时也可直接运行（Node.js ≥ 22.13）：

```bash
cd app && APP_MASTER_KEY=$(openssl rand -base64 32) DATA_DIR=./data node --disable-warning=ExperimentalWarning src/server.mjs
```
