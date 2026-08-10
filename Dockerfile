FROM mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4 AS ffmpeg

FROM node:24-bookworm-slim

ARG DEBIAN_MIRROR=""

ENV NODE_ENV=production \
    PORT=4173 \
    DATA_DIR=/data \
    HIGHLIGHTS_DIR=/media/highlights

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i \
        -e "s|http://deb.debian.org/debian-security|${DEBIAN_MIRROR%/}/debian-security|g" \
        -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR%/}/debian|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi \
  && apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    openssh-client \
    rsync \
    sqlite3 \
    zsh

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

RUN chmod 700 scripts/docker-entrypoint.zsh scripts/sync-azure-backup.zsh scripts/poll-azure-sync-request.zsh \
  && mkdir -p /data /media/highlights /home/node/.ssh \
  && chown -R node:node /data /media /home/node/.ssh

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4173/api/sync/status >/dev/null || exit 1

CMD ["/app/scripts/docker-entrypoint.zsh"]
