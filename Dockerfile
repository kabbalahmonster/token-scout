# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json eslint.config.mjs vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile=false
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate && groupadd --system doomscout && useradd --system --gid doomscout --home-dir /app doomscout
COPY --from=build --chown=doomscout:doomscout /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml* ./
COPY --from=build --chown=doomscout:doomscout /app/node_modules ./node_modules
COPY --from=build --chown=doomscout:doomscout /app/packages ./packages
COPY --from=build --chown=doomscout:doomscout /app/apps ./apps
RUN mkdir -p /data && chown doomscout:doomscout /data
USER doomscout

FROM runtime AS api
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/index.js"]

FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
