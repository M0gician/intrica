FROM node:24.18.0-bookworm
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap && rm -rf /var/lib/apt/lists/*
RUN corepack enable && pnpm --filter @intrica/server... --filter @intrica/web... install --frozen-lockfile
RUN pnpm --filter @intrica/server... --filter @intrica/web... build
ARG INTRICA_COMMIT
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 INTRICA_WEB_ROOT=/app/apps/web/dist INTRICA_DEPLOYMENT=container INTRICA_COMMIT=$INTRICA_COMMIT
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3001/api/v2/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/server/dist/server.js"]
