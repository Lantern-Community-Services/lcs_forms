# syntax=docker/dockerfile:1

# Lantern Forms — backend API (Express + Prisma).
# Build context is ./backend.

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
RUN npx prisma generate && npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
# node_modules is kept whole (not pruned): the entrypoint runs the Prisma CLI,
# and it lets an operator run `npm run seed` / `import:tenants` in the container.
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4200 \
    DATABASE_URL=file:/data/lantern-forms.db

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh

# Windows checkouts can turn the script's line endings into CRLF, which breaks
# the shebang. Normalise, then hand the SQLite data directory to the node user.
RUN sed -i 's/\r$//' docker-entrypoint.sh \
 && chmod +x docker-entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
