# ── Dashboard static build ────────────────────────────────────────────────────
FROM node:22-alpine AS dashboard-builder
ARG VITE_DEV_PERSONAS=false
ENV VITE_DEV_PERSONAS=$VITE_DEV_PERSONAS
WORKDIR /dashboard
COPY admin-dashboard/package*.json ./
RUN npm ci --include=dev
COPY admin-dashboard/ ./
# Remotion Player compositions are imported via @promo alias (resolves to /marketing/promo/src)
COPY marketing/promo/src/ /marketing/promo/src/
RUN npm run build

# ── TypeScript build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS ts-builder
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/prisma ./prisma
RUN npx prisma generate
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc

# ── Production image ─────────────────────────────────────────────────────────
FROM node:22-alpine
# openssl: Prisma. postgresql-client: pg_dump/psql for the /admin/migration
# dump+restore data-migration endpoints.
RUN apk add --no-cache openssl postgresql-client
WORKDIR /app
COPY backend/package*.json ./
COPY backend/prisma ./prisma
# argon2 ships no musl prebuild, so on Alpine npm falls back to a node-gyp source
# build — which needs python3 and a C++ toolchain. Without them the image build
# fails with "gyp ERR! find Python". Installed as a virtual package and deleted in
# the SAME layer so the toolchain never ships in the runtime image.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && npx prisma generate \
 && apk del .build-deps
COPY --from=ts-builder /app/dist ./dist
COPY --from=dashboard-builder /dashboard/dist ./admin-dashboard/dist
COPY backend/db/init.sql ./db/init.sql
COPY backend/baseline-migrations.sh ./
# releases.json is baked in as a seed; POST /admin/releases overwrites it at runtime
COPY backend/releases.json ./releases.json
# CLI install scripts served at /install.sh, /uninstall.sh, /install.ps1. Runtime
# resolves them under /app/Packaging/* (relative to dist/ as ../Packaging/*).
COPY Packaging/linux ./Packaging/linux
COPY Packaging/windows ./Packaging/windows
RUN chmod +x baseline-migrations.sh && mkdir -p /app/downloads
EXPOSE 7676
CMD ["sh", "-c", "./baseline-migrations.sh && node dist/server.js"]
