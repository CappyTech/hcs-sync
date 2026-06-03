# syntax=docker/dockerfile:1

# ── Stage 1: build CSS ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

# Install ALL deps (including devDependencies for Tailwind)
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy source then compile CSS
COPY src ./src
COPY tailwind.config.js postcss.config.js ./
RUN npm run build:css

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

# Install prod deps only
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Copy source and built assets from builder
COPY --from=builder /app/src ./src
# Overwrite the compiled stylesheet with the freshly built one
COPY --from=builder /app/src/server/public/styles.css ./src/server/public/styles.css

COPY .env.example ./.env.example

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server/index.js"]
