# Cards — Hetzner deploy.
#
# Multi-stage Next.js build. Stage 1 installs deps + builds the standalone
# server bundle (`output: 'standalone'`); Stage 2 ships only what's needed
# at runtime. Final image: ~150 MB instead of ~1.2 GB with the full deps.
#
# Build args:
#   BASE_PATH        — set to "/cards" when serving behind a sub-path; "" otherwise.
#                      Affects both Next.js basePath and a few client-side
#                      asset URLs (sw.js scope, pdf worker, sql-wasm locator).
#
# Build:
#   docker build --build-arg BASE_PATH=/cards -t cards:latest .
# Run (locally to verify):
#   docker run -p 3000:3000 -e PORT=3000 cards:latest

############
# 1. Build #
############
FROM node:20-alpine AS deps
WORKDIR /app
# Use the lockfile to get reproducible installs.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
ARG BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$BASE_PATH
# Standalone build packages a tiny Node server next to the .next/ output
# so the runtime stage doesn't need node_modules.
ENV STANDALONE_BUILD=true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

##############
# 2. Runtime #
##############
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Next default port; Caddy reverse-proxies to this.
ENV PORT=3000
# Re-export the built basePath so server-rendered routes know about it.
ARG BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$BASE_PATH

# `next build` with `output: standalone` produces:
#   .next/standalone   — a self-contained Node app + minimal node_modules
#   .next/static       — hashed JS/CSS chunks, served by the standalone server
#   public/            — public assets, served by the standalone server
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Drop privileges; run as the built-in `node` user.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
