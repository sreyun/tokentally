# 部署与运维手册

本文面向交付与运维人员，覆盖首次部署、HTTPS、云厂商接入、备份与恢复、升级、监控与常见问题。

## 1. 环境要求

| 项 | 要求 |
|---|---|
| 服务器 | Linux x86_64 / arm64，1 核 1 GB 起（账单规模较大时建议 2 核 2 GB） |
| 软件 | Docker 20.10+、Docker Compose v2 |
| 出网 | `*.aliyuncs.com`（阿里云）、`*.tencentcloudapi.com`（腾讯云）、告警渠道域名（oapi.dingtalk.com / open.feishu.cn / qyapi.weixin.qq.com） |
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

登录后依次完成：阿里云接入 / 腾讯云接入 → 测试连接 → 数据同步（回溯 12 个月并全量回溯）→ 预算管理 → 告警通知 → 归属设置（成本中心）→ 品牌设置。

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
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

建议同时配置 `ALLOW_CIDRS` 限制访问来源（如办公网出口 IP）。

## 4. 云厂商接入

### 阿里云百炼

- 创建 RAM 用户（仅 OpenAPI 调用访问），授予 `AliyunBailianReadOnlyAccess` + `AliyunBSSReadOnlyAccess` 或 README 中的最小权限策略
- 百炼 OpenAPI 地域默认 `cn-beijing`；国际站账号选择费用中心“国际站”

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
| 告警未收到 | 在“告警通知”中点“测试”；查看渠道卡片的最近错误；钉钉“自定义关键词”需包含“费用” |
| 忘记管理员密码 | 由另一位管理员在“用户管理”中重置；只有一个管理员时，停止服务后清空 users 表并重启，系统按 `.env` 重新创建初始管理员（账单与配置不受影响） |
