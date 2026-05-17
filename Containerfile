# Multi-stage Containerfile for darkmap.tinyland.dev (adapter-node).
#
# `production` stage is what CI pushes to ghcr.io and what the
# Kustomize Deployment runs.
#
# Build locally:
#   podman build --target=production -t darkmap:dev -f Containerfile .

ARG BASE_REGISTRY=docker.io

# ─────────────────────────────────────────────────────────────────────────
# Stage 1: deps — install pnpm dependencies (frozen lockfile)
# ─────────────────────────────────────────────────────────────────────────
FROM ${BASE_REGISTRY}/node:22-alpine AS deps
RUN apk add --no-cache libc6-compat \
    && corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod=false

# ─────────────────────────────────────────────────────────────────────────
# Stage 2: build — produce the adapter-node bundle
# ─────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm run build

# ─────────────────────────────────────────────────────────────────────────
# Stage 3: production — minimal runtime image
# ─────────────────────────────────────────────────────────────────────────
FROM ${BASE_REGISTRY}/node:22-alpine AS production
# node:22-alpine ships a non-root `node` user at uid/gid 1000 already —
# reuse it instead of creating a duplicate (alpine's busybox addgroup
# refuses to reassign an in-use gid, and we don't want root).
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Only the adapter-node bundle, package.json, and prod node_modules
# ride into the runtime image.
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules

USER node
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]
