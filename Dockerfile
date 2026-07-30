FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=4173 \
    DATA_DIR=/data \
    HIGHLIGHTS_DIR=/media/highlights

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    openssh-client \
    rsync \
    sqlite3 \
    zsh \
  && rm -rf /var/lib/apt/lists/*

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
