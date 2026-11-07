# 百炼 API Key 费用分析（Model Studio Cost Insight）

面向阿里云大模型服务平台百炼的 **API Key 级费用与模型用量综合分析系统**。通过 RAM 用户 AccessKey 调用阿里云只读 OpenAPI，
把业务空间、API Key（含描述/备注、权限、IP 白名单）以及费用中心账单定时同步到 SQLite 永久保存，围绕“每个 API Key 花了多少、花在哪、是否合理、会不会超支”
提供成本管理、预算预警、多维分摊与模型调用的深度分析。

- **交付形态**：`docker compose` 一键部署，对外是一个带登录的网址；可选 Caddy 自动 HTTPS
- **零第三方依赖**：Node.js 24 内置 `node:http` + `node:sqlite` + `node:crypto`，无 npm 包，供应链攻击面最小
- **口径与阿里云一致**：按账期查询用费用中心**月度账单**，按日期查询用**按天账单**，自然日按北京时间划分

---

## 功能

| 模块 | 回答的问题与内容 |
|---|---|
| **成本概览** | 本期花了多少、是否正常、会不会超预算、变化来自哪里（点击每日柱可下钻到当日 Key × 模型明细，点击月度柱切换账期）：本期费用（应付/原价/优惠后可切换）与环比、预算使用率与**月末预测**、每百万 Token 成本、缓存命中率；费用趋势（每日堆叠 / 本期与上期**累计对比** + 月末预测 / 近 12 个账期）；**关键发现**（费用变化驱动因素、超预算、集中度、异常日、缓存节省估算、治理风险、峰时占比、新增模型）；Key / 模型排行、费用构成、**变动归因**、治理摘要 |
| **API Key 分析** | 全部 Key（含无消费、已删除仍有账单的 Key）的描述、业务空间、状态、费用与环比、占比、**预算使用**、输入/输出 Token、缓存命中率、单位成本、主要模型、消费天数、最近消费、近 7 天、模型权限、IP 白名单；Key × 日期消耗热力 |
| **Key 详情页** | 单个 Key 的费用与排名（上一个/下一个快速切换，一键复制 Key ID）、Token、单位成本、命中率、预算/预测；按模型堆叠的每日费用、模型构成、近 12 个账期、计费维度、模型明细、计费项明细（单价/用量）、调用渠道、权限与**变更历史** |
| **模型分析** | 模型费用、Token 结构（输入/缓存/输出/向量）、命中率、输出/输入比、单位成本（仅比较 ≥10 万 Token 的模型）、计费维度（峰谷/缓存/思考/上下文档位）、每日费用、Key × 模型矩阵、模型 × 计费项 × 单价；模型详情抽屉（使用该模型的 Key、每日费用） |
| **成本分摊** | 多维透视：行/列任选 业务空间、API Key、模型、Token 类型、计费项、计费时段、渠道、日期、近 12 月；指标可选费用/原价/Token；数值或行/列/总占比、色阶；常用预设；单元格可下钻到对应账单明细；导出用于按项目/空间分摊 |
| **账单明细** | 与阿里云实例账单一一对应的逐条账单，导出 CSV 含全部字段（实例ID、单价、各类优惠与抵扣、商品 Code 等） |
| **Key 治理** | 自动检查：已删除/已禁用仍计费、超出/预计超出预算、费用突增（近 7 天日均 > 此前 2 倍）、有消费无描述、权限过宽（全部模型 + IP 不限）、闲置 30 天、未限制 IP、未归属业务空间（创建不足 30 天的新 Key 不计入闲置）；分级（高/中/低）并给出处置建议 |
| **变更记录** | 每次同步检测到的 API Key / 业务空间新增、修改、删除、恢复 |
| **系统管理** | 阿里云接入（AccessKey 加密配置与连通性测试）、数据同步、**预算管理**（月度总预算、预警阈值、各 Key 月度预算，可按上月 ×1.2 一键填充）、**预算告警通知**（钉钉 / 飞书 / 企业微信群机器人与通用 Webhook，支持加签）、用户管理、安全与审计、接口日志 |

全局：账期 / 日期两种口径切换，筛选（业务空间、API Key、模型、Token 类型、计费项、渠道、关键字，已选条件以标签显示可单独移除），费用口径切换，
浅色 / 深色 / 跟随系统主题，页面地址可收藏分享（如 `#/key/171769`），键盘 `/` 聚焦搜索，所有表格支持排序、首列冻结、紧凑模式与 CSV 导出。

### 预算告警通知

在“系统管理 → 预算管理”中配置通知渠道后，系统会在 **每次账单同步完成、预算或通知设置变更后** 检查本月（自然月账期）预算：

| 条件 | 说明 |
|---|---|
| 达到预警阈值 | 月度总预算或单个 Key 预算的使用率 ≥ 预警阈值（默认 80%） |
| 超出预算 | 应付金额 ≥ 预算；同时满足时只发送“超出”一条 |
| 预计月末超出 | 按与页面一致的月末预测口径推算将超出月度总预算 |

- 同一阈值（含预算金额）每个账期只通知一次，次月自动重置；调整预算金额后按新阈值重新计算；发送失败会在下次同步时重试
- 钉钉、飞书支持加签；通用 Webhook 以 POST JSON 推送，配置密钥后附带 `X-Alert-Timestamp` 与 `X-Alert-Signature: sha256=HMAC(secret, timestamp + "." + body)`
- Webhook 地址与密钥加密保存且不回显；仅允许 HTTPS，钉钉/飞书/企业微信只允许官方域名，连接时拒绝解析到内网/保留地址的目标（防 SSRF / DNS 重绑定）
- 设置 `PUBLIC_URL` 后消息中会附带“打开费用分析”链接

## 部署

需要一台能访问 `*.aliyuncs.com` 的 Linux 服务器，已安装 Docker 与 Docker Compose v2。

```bash
cp .env.example .env
```

```bash
chmod 600 .env
```

编辑 `.env`，至少填写主密钥（用于加密 AccessKey，请单独妥善保管）：

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

浏览器打开 `http://服务器IP:8080`，登录后进入 **系统管理 → 阿里云接入** 填写 RAM 用户 AccessKey，点“测试已保存配置”确认 5 项接口均通过。
系统随即自动同步业务空间、API Key 与最近 3 个账期的账单（约 1 分钟）。建议随后在“数据同步”中将回溯账期数调为 12 并点“全量回溯”，
再在“预算管理”中设置月度总预算与重点 Key 的预算。

### 对外提供 HTTPS（推荐）

域名解析到服务器并开放 80/443 后，在 `.env` 中设置：

```
DOMAIN=cost.example.com
BIND_ADDR=127.0.0.1
TRUST_PROXY=true
```

```bash
docker compose --profile https up -d --build
```

Caddy 会自动申请并续期 Let's Encrypt 证书；应用端口只绑定本机，Cookie 自动加 `Secure`，并下发 HSTS。
如使用已有的 Nginx / SLB，同样设置 `BIND_ADDR=127.0.0.1`、`TRUST_PROXY=true`，并让代理传递 `X-Forwarded-For` 与 `X-Forwarded-Proto`。

## RAM 权限（只读）

为本系统创建专用 RAM 用户，授予以下系统策略之一即可：

- `AliyunBailianReadOnlyAccess` + `AliyunBSSReadOnlyAccess`

或最小权限自定义策略：

```json
{
  "Version": "1",
  "Statement": [
    { "Effect": "Allow", "Action": ["modelstudio:ListWorkspaces", "modelstudio:ListApiKeys", "modelstudio:GetApiKey", "modelstudio:GetBillingOverview", "modelstudio:GetBillingTrend"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["bss:DescribeInstanceBill", "bss:QueryBillOverview"], "Resource": "*" }
  ]
}
```

## 数据来源与口径

| 数据 | 接口 | 同步策略 |
|---|---|---|
| 业务空间 | ModelStudio `ListWorkspaces`（2026-02-10） | 默认每 5 分钟，记录变更 |
| API Key、描述、归属、权限、IP 白名单 | ModelStudio `ListApiKeys`（全局 + 逐业务空间补全） | 同上；阿里云已删除的 Key 标记为“已删除”并保留历史 |
| 账期（月）账单 | BssOpenApi `DescribeInstanceBill` · MONTHLY · 按计费项 | 默认每 60 分钟；已出账账期（次月 4 日起）同步一次后定稿 |
| 按日账单 | BssOpenApi `DescribeInstanceBill` · DAILY · 按计费项 | 最近 3 天每次刷新，其余未出账日每 12 小时校正 |
| 对账 | ModelStudio `GetBillingOverview`（按 API_KEY_ID） | 随账单同步 |

- 账单以“账期/日 + 产品”为单位整体替换，金额回调、出账修正都会同步进来；百炼产品代码通过 `QueryBillOverview` 自动识别（通常为 `sfm`）。
- 实例ID解析：`ApiKeyID;业务空间ID;模型;计费项;[调用渠道];[免费额度用完即停]`。计费项如 `input_token_cache_peak` 解析为“输入 · 缓存命中 · 峰时”，
  `context_0-256k_output_token` 解析为“输出 · 上下文 0-256k”。ApiKeyID 为空表示控制台体验、订阅套餐、Batch 等非 Key 调用。
- **应付金额** = 原价 − 优惠 − 优惠券抵扣（税前）；可切换为原价或优惠后金额。
- 环比：历史账期对比上月全月；当月对比“上月同期”（相同天数）；按日期查询对比上一个等长周期。
- 账单相对实际调用约延迟数小时，当月数据仅供参考，次月 3 日后出账为准。

## 安全措施

| 层面 | 措施 |
|---|---|
| 凭证 | AccessKey ID 与 Secret 以 **AES-256-GCM** 加密后存入 SQLite（AAD 绑定字段名），Secret 只写不回显；主密钥来自环境变量 `APP_MASTER_KEY`，与数据卷分离 |
| 账号 | 密码 scrypt（N=32768）哈希；至少 10 位且含字母与数字；首次登录/重置后强制改密；改密后其他会话失效 |
| 敏感操作 | 更换 AccessKey 须再次输入当前登录密码；修改密码 / 二次验证连续输错 5 次强制退出该用户全部会话并记录审计 |
| 登录防护 | 单用户连续 5 次失败锁定 15 分钟；单 IP 15 分钟内最多 20 次失败；统一错误提示与等时校验，防止枚举用户名 |
| 会话 | 随机 256 位令牌（库中仅存哈希）；HttpOnly + SameSite=Strict（HTTPS 下 Secure + `__Host-` 前缀）；空闲 2 小时 / 最长 12 小时过期 |
| 请求 | CSRF 令牌 + Origin 校验；严格 CSP（禁止内联脚本）、X-Frame-Options、nosniff、Referrer-Policy、HSTS、`X-Robots-Tag: noindex`；请求体大小与频率限制；可选 IP 白名单 `ALLOW_CIDRS` |
| 权限 | 管理员 / 只读两种角色；后端只开放阿里云只读接口白名单 |
| 审计 | 登录成败、配置变更、二次验证失败、用户管理、同步触发、告警发送全部写入审计日志 |
| 容器 | 非 root（uid 1000）、只读根文件系统、`cap_drop: ALL`、`no-new-privileges`、内存/CPU/进程数限制、健康检查、日志轮转 |

## 运维

备份（SQLite 在线备份，同时请另外妥善保存 `.env` 中的 `APP_MASTER_KEY`）：

```bash
docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/bailian-cost.db').exec(\"VACUUM INTO '/data/backup.db'\")" && docker compose cp app:/data/backup.db ./bailian-cost-$(date +%F).db
```

升级：

```bash
docker compose up -d --build
```

忘记管理员密码时，可让另一位管理员在“用户管理”中重置；若只有一个管理员，可停止服务后删除数据库中的 users 表记录并重启，系统会按 `.env` 重新创建初始管理员（账单与配置不受影响）。

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
| `ALIBABA_CLOUD_ACCESS_KEY_ID` / `_SECRET` | — | 可选，首次启动导入后加密存库，建议之后从 `.env` 删除 |
| `PUBLIC_URL` | — | 可选，对外访问地址，用于告警消息中的跳转链接 |
| `ALERT_ALLOW_PRIVATE` | false | 允许通用 Webhook 指向内网地址（仅在接收端位于内网时开启） |

## 目录结构

```
├── docker-compose.yml   # app + 可选 caddy(https)
├── Dockerfile
├── Caddyfile
├── .env.example
└── app
    ├── src
    │   ├── server.mjs   # HTTP、鉴权、会话、CSRF、限流、路由
    │   ├── sync.mjs     # 定时同步（元数据 / 账期账单 / 日账单 / 对账）
    │   ├── alerts.mjs   # 预算告警评估与 Webhook 推送（加签、SSRF 防护）
    │   ├── aliyun.mjs   # ACS3-HMAC-SHA256 签名客户端、账单实例ID解析
    │   ├── db.mjs       # SQLite 结构与读写
    │   ├── crypto.mjs   # scrypt、AES-256-GCM、主密钥
    │   └── config.mjs
    └── public           # 前端（原生 ES 模块，无外部 CDN 与构建步骤）
        ├── index.html / login.html / app.css   # 外壳、登录页、设计系统（浅色/深色令牌）
        └── js
            ├── main.js        # 路由、导航、周期、筛选、同步状态、用户菜单、主题
            ├── core.js        # 状态、格式化、账单解析与聚合、预测与预算
            ├── charts.js      # 柱/线/排行/发散/分段/热力等 SVG 组件
            ├── table.js       # 表格（排序、分页、首列冻结、键盘、CSV 防公式注入）
            ├── insights.js    # 关键发现规则
            └── views/         # overview · keys · key · day · models · pivot · detail · governance · changes · admin
```

`/api/data` 按数据版本返回 ETag，数据未变化时 304，页面刷新/轮询不重复传输。

预算按自然月的应付金额计；月末预测 = 已完成日合计 + 今日已入账 + 已完成日（按日历日，含无消费日）日均 × 今日之后的剩余天数。
月度趋势与“近 12 月”分摊依赖历史账期数据，建议在“系统管理 → 数据同步”中把回溯账期数设为 12。

不使用 Docker 时也可直接运行（Node.js ≥ 22.13）：

```bash
cd app && APP_MASTER_KEY=$(openssl rand -base64 32) DATA_DIR=./data node --disable-warning=ExperimentalWarning src/server.mjs
```
