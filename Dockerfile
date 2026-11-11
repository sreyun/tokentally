# TokenTally 大模型 API Key 费用分析（阿里云百炼 + 腾讯云 TokenHub）—— 零第三方依赖（node:http + node:sqlite + node:crypto）
# 生产环境建议把基础镜像固定到具体版本或 digest，例如 node:24.11.1-alpine3.22
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

WORKDIR /app
COPY --chown=root:root app/package.json ./
COPY --chown=root:root app/src ./src
COPY --chown=root:root app/public ./public
# IP 归属地离线库（ip2region，Apache-2.0 / MIT），只读查询，不联网
COPY --chown=root:root app/geo ./geo

# 应用代码只读；数据目录归 node 用户（uid 1000）
RUN mkdir -p /data && chown node:node /data && chmod 700 /data \
    && node --disable-warning=ExperimentalWarning src/server.mjs --selftest

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
