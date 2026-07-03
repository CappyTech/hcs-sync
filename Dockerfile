# ── Stage 1: build CSS ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY src ./src
COPY tailwind.config.js postcss.config.js ./
RUN npm run build:css

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

RUN apk add --no-cache dumb-init curl tailscale

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY --from=builder /app/src ./src
COPY .env.example ./.env.example
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000

# Build identity for the footer (the image has no .git to fall back on).
# CI passes these; manual builds:
#   docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) --build-arg GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD) ...
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
ARG GIT_BRANCH=
ENV GIT_BRANCH=$GIT_BRANCH

EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server/index.js"]
