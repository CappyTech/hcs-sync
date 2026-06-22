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

RUN apk add --no-cache dumb-init curl

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY --from=builder /app/src ./src
COPY .env.example ./.env.example

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/server/index.js"]
