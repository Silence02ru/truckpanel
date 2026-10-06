# syntax=docker/dockerfile:1
# TruckPanel panel image: Fastify API + built SPA. Build context: repository root.

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
COPY apps apps
RUN pnpm --filter @truckpanel/shared build \
 && pnpm --filter @truckpanel/sii build \
 && pnpm --filter @truckpanel/panel build \
 && pnpm --filter @truckpanel/web build \
 && pnpm --filter @truckpanel/panel deploy --prod /out

FROM node:24-slim
ENV NODE_ENV=production \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=8080 \
    WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /src/apps/web/dist /app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
