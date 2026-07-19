FROM oven/bun:1-debian AS web-build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/web ./apps/web
RUN bun run --cwd apps/web build


FROM oven/bun:1-debian AS runtime

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      mariadb-server \
      mariadb-client \
      gosu \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /etc/mysql /etc/my.cnf /etc/my.cnf.d /var/lib/mysql

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    KILNDB_DATA_DIR=/data \
    KILNDB_WEB_DIST=/app/apps/web/dist

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN bun install --frozen-lockfile --production

COPY apps/api ./apps/api
COPY packages ./packages
COPY --from=web-build /app/apps/web/dist ./apps/web/dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && useradd --system --create-home --home-dir /home/kilndb --shell /usr/sbin/nologin kilndb \
 && mkdir -p /data \
 && chown -R kilndb:kilndb /data /app

VOLUME ["/data"]

EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
