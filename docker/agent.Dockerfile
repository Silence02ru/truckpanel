# syntax=docker/dockerfile:1
# TruckPanel agent: the only component with docker.sock. Build context: repository root.
FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sii/package.json packages/sii/
COPY apps/agent/package.json apps/agent/
COPY apps/panel/package.json apps/panel/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/agent apps/agent
RUN pnpm --filter @truckpanel/shared build \
 && pnpm --filter @truckpanel/agent build \
 && pnpm --filter @truckpanel/agent deploy --prod /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# Runs as root: it manages Docker and chowns server directories to the game user (uid 1000).
CMD ["node", "dist/main.js"]
