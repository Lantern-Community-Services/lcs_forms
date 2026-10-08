# syntax=docker/dockerfile:1

# Lantern Forms — frontend (Next.js, standalone output).
# Build context is ./frontend.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
# next.config.mjs bakes the /api/* rewrite into the build, so the backend's
# address has to be known here, not just at runtime: one web image per
# environment (the pipeline passes that environment's API URL, e.g.
# https://<api app>.azurewebsites.net). The default is the compose service name.
ARG BACKEND_URL=http://backend:4200
ARG NEXT_PUBLIC_API_BASE_URL=
ENV BACKEND_URL=${BACKEND_URL} \
    NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
# Listens on 0.0.0.0:5200 (App Service: WEBSITES_PORT=5200).
FROM base AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=5200

# The standalone server needs public/ and .next/static copied in beside it.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 5200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

# Next's standalone server binds to $HOSTNAME, and container platforms set
# HOSTNAME to the container's own name, so it's pinned here rather than in ENV.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
