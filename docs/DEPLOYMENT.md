# 部署与运维手册

本文面向交付与运维人员，覆盖首次部署、HTTPS、云厂商接入、备份与恢复、升级、监控与常见问题。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| 服务器 | Linux x86_64 / arm64，1 核 1 GB 起（账单规模较大时建议 2 核 2 GB） |
| 软件 | Docker 20.10+、Docker Compose v2 |
| 出网 | `*.aliyuncs.com`（阿里云）、`*.tencentcloudapi.com`（腾讯云）、告警渠道域名（oapi.dingtalk.com / open.feishu.cn / qyapi.weixin.qq.com）；接入阿里云调用次数时还需能访问云监控 Prometheus 的 HTTP API 地址 |
| 入网 | 8080（直连）或 80/443（启用 HTTPS profile） |

## 2. 首次部署

```bash
git clone https://github.com/sreyun/tokentally.git && cd tokentally
```

```bash
cp .env.example .env && chmod 600 .env
```

生成主密钥并填入 `.env` 的 `APP_MASTER_KEY=`（**请把主密钥另行保存到密码管理器**：丢失后已保存的访问密钥将无法解密，需要重新填写）：

```bash
openssl rand -base64 32
```

```bash
docker compose up -d --build
```

```bash
docker compose logs app | grep 初始管理员密码
```

> 想先体验？在 `.env` 中设置 `DEMO_DATA=true` 后启动，系统会生成虚构演示数据；配置真实访问密钥后演示数据自动清除。

登录后依次完成：阿里云接入 / 腾讯云接入 → 测试连接 → 数据同步（回溯 12 个月并全量回溯）→ 预算管理 → 告警通知 → 归属设置（成本中心，在“Key 分析”页面）→ 品牌设置。

> 页面地址中包含统计周期与筛选条件（如 `#/keys?cycle=2026-10&ws=…`），可直接收藏或发给同事；配置 `PUBLIC_URL` 后，告警与报表消息中的“查看详情”会直达对应页面与周期。
>
> **只读分享链接**同样依赖 `PUBLIC_URL`：链接形如 `https://cost.example.com/share#<令牌>`，反向代理需放行 `/share`、`/share-boot.js` 与 `/api/share/*`（与其他路径相同，无需特殊配置）。设置了 `ALLOW_CIDRS` 时分享链接同样只能从允许的网段打开。分享会话保存在内存中，服务重启后已打开的页面会用本标签页保存的令牌自动重新打开。

## 3. 对外提供 HTTPS

方式一：内置 Caddy（自动申请 Let's Encrypt 证书）。域名解析到服务器、开放 80/443 后，在 `.env` 设置：

```
DOMAIN=cost.example.com
BIND_ADDR=127.0.0.1
TRUST_PROXY=true
PUBLIC_URL=https://cost.example.com
```

```bash
docker compose --profile https up -d --build
```

方式二：已有 Nginx / SLB / Ingress。设置 `BIND_ADDR=127.0.0.1`（或仅内网可达）、`TRUST_PROXY=true`，代理需传递 `X-Forwarded-For`、`X-Forwarded-Proto` 与 `Host`。Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;   # 保留端口：非 443/80 端口访问时同源校验需要完整的 Host
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> 客户端 IP 取 `X-Forwarded-For` **从右往左**第 N 个地址（N = 可信代理层数）：最左侧的地址可由客户端随意填写，不能用于登录限流与 IP 白名单。只有一层代理时 `TRUST_PROXY=true` 即可；多层代理（如 SLB → Nginx → 本服务）时设为层数，例如 `TRUST_PROXY=2`。
>
> 只有来自可信代理地址的请求才会采用 `X-Forwarded-*` 头：默认信任本机、内网（10/8、172.16/12、192.168/16）与 100.64.0.0/10（阿里云 SLB 等）。代理不在这些网段时，用 `TRUSTED_PROXIES` 指定代理地址；服务端口可被公网直接访问时也应设置，避免客户端伪造这些头绕过 IP 白名单与登录限流。

**客户端 IP 显示为内网地址**：说明 IP 来源与代理链不一致。打开“系统管理 → 安全与审计 → 客户端 IP 识别”，面板会显示服务端收到的连接地址、X-Forwarded-For、X-Real-IP 与推荐设置（例如 SLB → OpenResty → 本服务应选“X-Forwarded-For，可信代理 2 层”），点“按建议填写”并输入当前密码保存即可，立即生效、无需重启。页面设置优先于 `TRUST_PROXY`。

**邮件通知发送失败**：常见原因：① 云服务器默认封禁出站 25 端口，请使用 465（SSL / TLS）或 587（STARTTLS）；② QQ / 163 / 企业微信邮箱需在邮箱设置中开启 SMTP 并使用**授权码**而不是登录密码；③ 阿里云邮件推送（smtpdm.aliyun.com）需使用发信地址与 SMTP 密码；④ 内网邮件中继需设置 `ALERT_ALLOW_PRIVATE=true`（默认拒绝解析到内网的服务器）。可在“告警通知 → 邮件服务器（SMTP）”中发送测试邮件，失败原因会直接显示；发送记录与失败原因也会写入审计日志与系统日志。

**IP 归属地显示“未知归属地”或数据较旧**：镜像内置 ip2region IPv4 离线库（只在本机查询，不联网）。到 https://github.com/lionsoul2014/ip2region 的 data 目录下载新版 `ip2region_v4.xdb` 放到数据卷（`/data/ip2region_v4.xdb`）后重启即可覆盖内置版本；IPv6 地址需要另外放入 `ip2region_v6.xdb`（约 37 MB）。当前使用的库与数据日期见“系统管理 → 安全与审计 → 安全策略 → IP 归属地库”。

**账号被锁定**：连续输错密码会临时锁定账号（`LOGIN_LOCK_MINUTES`，默认 15 分钟），管理员可在“用户管理”中解锁其他用户。唯一的管理员被锁定时，在服务器上执行：

```bash
docker compose exec app node src/server.mjs --unlock-user=admin
```

建议同时配置 `ALLOW_CIDRS` 限制访问来源（如办公网出口 IP）。健康检查 `/healthz`、`/readyz` 不受白名单限制，`/metrics` 仍受白名单与令牌双重保护（请把 Prometheus 所在地址加入白名单）。

## 4. 云厂商接入

### 阿里云百炼

- 创建 RAM 用户（仅 OpenAPI 调用访问），授予 `AliyunBailianReadOnlyAccess` + `AliyunBSSReadOnlyAccess` 或 README 中的最小权限策略
- 百炼 OpenAPI 地域默认 `cn-beijing`；国际站账号选择费用中心“国际站”

#### 阿里云调用次数（可选，v1.4+）

百炼 OpenAPI 与费用中心账单不含调用次数。开启百炼“监控数据投递”后，调用次数写入云监控 Prometheus 实例，TokenTally 通过其标准 HTTP API（`/api/v1/query_range` 等）只读查询：

1. 百炼控制台 → 监控告警 → 开启**监控数据投递**，选择（或新建）云监控 Prometheus 实例
2. 打开该 Prometheus 实例的“设置”页，复制 **HTTP API 地址**：本系统部署在同一 VPC 时用内网地址，否则用公网地址；实例开启鉴权时同时复制 Token
3. 系统管理 → 阿里云接入 → **调用次数**：填写地址与认证方式 → “发现指标”自动推荐调用次数 / 失败次数指标与 API Key、模型标签 → “预览近 7 天”与百炼控制台“模型用量”核对 → 勾选启用并保存

说明：

- 调用次数随阿里云账单同步更新（默认每 60 分钟），每次回读最近 N 天（默认 62 天，可调整）；Prometheus 中已过期的日期保留本地已同步的记录
- 单次平均 Token 取同日同 Key 同模型的账单 Token；模型名对不上时，该 Key 当日剩余的账单 Token 按调用次数比例分配，保证 Key 级单次平均与账单一致
- 修改 Prometheus 地址或认证信息需二次验证；Token 以 AES-256-GCM 加密保存、不回显；修改指标映射会清空已同步的阿里云调用次数并按新配置重新读取
- 安全限制：只允许 http / https，不跟随重定向；云服务器元数据地址（100.100.100.200、169.254.0.0/16）与本机回环地址禁止访问（同机部署的 Prometheus 可设置 `PROM_ALLOW_LOOPBACK=true`）

### 腾讯云 TokenHub

- 创建 CAM 子用户（仅编程访问），授予 TokenHub 只读与费用中心账单只读权限
- TokenHub 地域：华南地区（广州）`ap-guangzhou` 或 亚太东南（新加坡）`ap-singapore`；国际站账号选择“国际站”
- 账单产品代码（BusinessCode）一般留空自动识别；若自动识别失败，可在计费中心账单中查看 TokenHub 的产品代码后固定填写
- 腾讯云账单不含 API Key，Key 级费用按 TokenHub 用量占比分摊；用量统计最长约 90 天，更早账期的费用可能计入“无 API Key”
- 未授予计费只读权限时，可勾选“按目录价估算”，获得权限后下一次同步自动替换为真实账单

## 5. 备份与恢复

### 自动备份

每天 `BACKUP_HOUR` 点（默认 3 点，账单时区）在数据卷 `/data/backups/` 生成 `tokentally-YYYYMMDD-HHMMSS.db`，保留最近 `BACKUP_KEEP` 份（默认 7，设为 0 关闭）。
手动备份（管理页“品牌与备份 → 立即备份”）最多保留 10 份。备份包含账单、配置、用户（scrypt 哈希）与 **加密后** 的访问密钥。

建议定期把备份复制到异地（对象存储 / 备份服务器）：

```bash
docker compose cp app:/data/backups ./backups-$(date +%F)
```

### 恢复

```bash
docker compose stop app
```

将备份复制为数据卷中的 `bailian-cost.db`，并删除同目录的 `bailian-cost.db-wal`、`bailian-cost.db-shm`（以下示例使用一个临时容器挂载数据卷，卷名以 `docker volume ls` 为准）：

```bash
docker run --rm -v tokentally_bailian-data:/data -v "$PWD":/backup alpine sh -c "cp /backup/tokentally-20261101-030000.db /data/bailian-cost.db && rm -f /data/bailian-cost.db-wal /data/bailian-cost.db-shm && chown 1000:1000 /data/bailian-cost.db"
```

确认 `.env` 中的 `APP_MASTER_KEY` 与备份时一致，然后：

```bash
docker compose start app
```

## 6. 升级

```bash
git pull && docker compose up -d --build
```

数据库在启动时自动迁移，升级前建议先在管理页手动备份一次。v1.1 → v1.2：

- 账单、Key、业务空间、同步记录增加云厂商字段，历史数据归属阿里云
- 新增用量表（腾讯云请求数 / Token）与成本中心标签表
- v1.1 的单渠道预算告警自动转换为一个通知渠道（地址与密钥随之迁移，已通知记录保留）

## 7. 监控

| 接口 | 用途 |
|---|---|
| `GET /healthz` | 存活检查（容器 HEALTHCHECK 使用） |
| `GET /readyz` | 就绪检查（数据库可用） |
| `GET /metrics` | Prometheus 指标，需在 `.env` 设置 ≥16 位的 `METRICS_TOKEN` |

Prometheus 抓取示例：

```yaml
scrape_configs:
  - job_name: tokentally
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['cost.example.com']
```

常用告警规则：`tokentally_sync_last_ok == 0`（同步失败）、`time() - tokentally_sync_last_success_timestamp_seconds{kind="bills"} > 7200`（账单超过 2 小时未更新）、
`tokentally_budget_usage_ratio > 0.9`、`tokentally_alert_channel_error == 1`（告警渠道发送失败）。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| 连接测试提示签名错误 | 核对 Secret / SecretKey；检查服务器时间（与标准时间偏差需小于 5 分钟） |
| 提示缺少接口权限 | 按“权限”章节为 RAM / CAM 子用户授权，权限生效约需 1 分钟 |
| 腾讯云费用出现在“无 API Key” | 该部分账单在 TokenHub 用量中找不到对应模型（控制台体验、非 API Key 调用、超过 90 天的账期等） |
| 已保存的密钥无法解密 | `APP_MASTER_KEY` 被更换；恢复原主密钥，或在管理页重新填写访问密钥与告警渠道 |
| 告警未收到 | 在“告警通知”中点“测试”；查看渠道卡片的最近错误；钉钉 / 飞书“自定义关键词”建议设为“费用”或产品名称。保存配置不会立即推送：报表看渠道卡片上的“下次报表”时间，告警在出现新的条件时发送 |
| 阿里云调用次数“发现指标”找不到指标 | 确认百炼已开启监控数据投递且投递到所填实例（投递后约数分钟出现数据）；HTTP API 地址填写实例“设置”页中的地址；VPC 内网地址需本系统位于同一 VPC |
| 调用次数提示“标签值未匹配” | 所选 API Key 标签的值不是 API Key ID（或 Key 尚未同步）；在“发现指标”结果中改选正确的标签，或先同步 API Key |
| 页面放着不动一段时间后要求重新登录 | 正常：后台轮询不会延长会话，空闲超过 `SESSION_IDLE_MINUTES`（默认 120 分钟）后需重新登录 |
| 忘记管理员密码 | 由另一位管理员在“用户管理”中重置；只有一个管理员时，停止服务后清空 users 表并重启，系统按 `.env` 重新创建初始管理员（账单与配置不受影响） |
