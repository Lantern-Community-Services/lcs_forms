# syntax=docker/dockerfile:1

# Lantern Forms — backend API (Express + Prisma, Azure SQL).
# Build context is ./backend.
#
#   docker run -e DATABASE_URL=… <image>                          the API, on 0.0.0.0:4200
#   docker run -e DATABASE_URL=… -e RUN_MIGRATIONS=true <image>   apply migrations and exit

ARG NODE_VERSION=22

# ── base: Node plus what Prisma's query engine needs at runtime ──────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── build: full install, generate the Prisma client, compile TypeScript ──────
FROM base AS build
COPY package.json package-lock.json ./
# The schema must be present before install so @prisma/client can generate.
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
# The client is generated here, inside the Linux image, for the schema's
# provider (sqlserver) and this platform's query engine; the build fails if it
# can't be. `prisma generate` doesn't connect to a database.
RUN npx prisma generate && npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
# node_modules is kept whole (not pruned): RUN_MIGRATIONS runs the Prisma CLI,
# and it lets an operator run the importers in the container.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4200

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json ./
COPY prisma ./prisma
# The scripts (importers, files:to-blob) run from source with tsx.
COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# Windows checkouts can turn the script's line endings into CRLF, which breaks
# the shebang.
RUN sed -i 's/\r$//' docker-entrypoint.sh \
 && chmod +x docker-entrypoint.sh \
 && chown -R node:node /app

USER node
EXPOSE 4200

# Liveness only: the process answers. A database blip mustn't get the
# container restarted (see /api/health in src/app.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
