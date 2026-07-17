# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy Prisma schema and generate Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

# Copy application source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Install wget for health checks
RUN apk add --no-cache wget

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Copy Prisma schema and generate Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

# Copy compiled application
COPY --from=builder /app/dist ./dist

# Entrypoint (runs migrations then starts the server as PID 1)
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Create a non-root user
RUN addgroup -S nodejs && \
    adduser -S vaketta -G nodejs

USER vaketta

# Internal application port
EXPOSE 5000

# Liveness probe — /health always returns 200 while the process is responsive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
CMD wget -qO- http://localhost:5000/health || exit 1

# Apply migrations, then start the server (exec = SIGTERM reaches Node for graceful shutdown)
CMD ["./docker-entrypoint.sh"]
