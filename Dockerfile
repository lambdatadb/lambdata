# The base image is pinned to an exact Bun release on Debian trixie, which ships
# MariaDB 11.8. To move to a newer Bun, set BUN_VERSION to another tag from
# https://hub.docker.com/r/oven/bun/tags (keep the "-debian" variant), rebuild, and
# run the API test suites inside the new image before publishing it. A newer Debian
# release can bring a newer MariaDB major version; LambData runs mariadb-upgrade at
# the first boot after such a change, but test it on a copy of real data first.
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION}-debian AS web-build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/web ./apps/web
RUN bun run --cwd apps/web build


# Cloudflare's apt signing key is downloaded here and only trusted if its primary
# key fingerprint matches the one pinned below ("CloudFlare Software Packaging
# 2025"). When Cloudflare rotates the key the build stops; check the new key with
# Cloudflare and update CLOUDFLARE_SIGNER_FINGERPRINT.
FROM oven/bun:${BUN_VERSION}-debian AS cloudflare-key
ARG CLOUDFLARE_SIGNER_FINGERPRINT=CC94B39C77AE7342A68B89628A682D308D4E5E73
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /cloudflare-main.gpg \
 && fpr="$(gpg --show-keys --with-colons /cloudflare-main.gpg | awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; want = 0 }')" \
 && if [ "$fpr" != "$CLOUDFLARE_SIGNER_FINGERPRINT" ]; then echo "Cloudflare apt key fingerprint is '$fpr', expected $CLOUDFLARE_SIGNER_FINGERPRINT" >&2; exit 1; fi


FROM oven/bun:${BUN_VERSION}-debian AS runtime

# cloudflared is pinned so a rebuild cannot silently change it; LambData only runs
# it when an admin picks "Managed here" for the tunnel. Bump CLOUDFLARED_VERSION to
# a version listed by `apt-cache policy cloudflared` in a container of this image.
ARG CLOUDFLARED_VERSION=2026.10.7

# The runtime user keeps uid and gid 999, the values earlier images assigned, so an
# existing /data volume stays owned by the user that runs LambData.
ARG APP_UID=999
ARG APP_GID=999

COPY --from=cloudflare-key /cloudflare-main.gpg /usr/share/keyrings/cloudflare-main.gpg

# Only what LambData runs is installed: mariadbd, mariadb-install-db and
# mariadb-upgrade (mariadb-server-core), mariadb, mariadb-dump and mariadb-admin
# (mariadb-client, which also pulls in perl for its helper scripts), gosu and
# cloudflared. The packaged MariaDB configuration is removed because LambData
# passes every server option itself.
RUN chmod 0644 /usr/share/keyrings/cloudflare-main.gpg \
 && echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      > /etc/apt/sources.list.d/cloudflared.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      mariadb-server-core \
      mariadb-client \
      gosu \
      ca-certificates \
      "cloudflared=${CLOUDFLARED_VERSION}" \
 && for tool in mariadbd mariadb-install-db mariadb-upgrade mariadb-dump mariadb mariadb-admin gosu cloudflared; do \
      command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }; \
    done \
 && mariadbd --version \
 && cloudflared --version \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /etc/mysql /etc/my.cnf /etc/my.cnf.d /var/lib/mysql

# The application is owned by root and read-only for the runtime user. MariaDB may
# only read or write files in an empty, root-owned folder (secure_file_priv).
RUN groupadd --system --gid "${APP_GID}" lambdata \
 && useradd --system --uid "${APP_UID}" --gid "${APP_GID}" --create-home --home-dir /home/lambdata --shell /usr/sbin/nologin lambdata \
 && mkdir -p /data /usr/local/share/lambdata/no-file-access \
 && chown "${APP_UID}:${APP_GID}" /data \
 && chmod 0555 /usr/local/share/lambdata/no-file-access

WORKDIR /app

# The data directory is resolved by docker-entrypoint.sh (LAMBDATA_DATA_DIR, then
# legacy KILNDB_DATA_DIR, then /data) and is deliberately not set here, so a
# container that still sets the legacy variable keeps its value.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    LAMBDATA_WEB_DIST=/app/apps/web/dist \
    LAMBDATA_MARIADB_SECURE_FILE_PRIV=/usr/local/share/lambdata/no-file-access \
    LAMBDATA_APP_UID=${APP_UID} \
    LAMBDATA_APP_GID=${APP_GID}

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN bun install --frozen-lockfile --production

COPY apps/api ./apps/api
COPY packages ./packages
COPY --from=web-build /app/apps/web/dist ./apps/web/dist

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]

EXPOSE 4317

# /api/health answers 503 while MariaDB is expected but not running, so a server
# that cannot start (or keeps failing) shows as unhealthy. The start period covers
# a first boot that initializes MariaDB or upgrades its data directory.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
