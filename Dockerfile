# Builder stage
FROM node:22-alpine@sha256:3a4802e64ab5181c7870d6ddd8c824c2efc42873baae37d1971451668659483b AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config and root package files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy shared, core, and api packages
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/api ./packages/api

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Build shared and core first
RUN pnpm --filter @percolator/shared build
RUN pnpm --filter @percolator/sdk build

# Build api
RUN pnpm --filter @percolator/api build

# Runner stage
FROM node:22-alpine@sha256:3a4802e64ab5181c7870d6ddd8c824c2efc42873baae37d1971451668659483b AS runner

# Install curl for health checks
RUN apk add --no-cache curl

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/package.json ./packages/api/

# Copy all node_modules
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/api/node_modules ./packages/api/node_modules

# Copy workspace config for runtime
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/package.json ./

# Change ownership to node user
RUN chown -R node:node /app

# Switch to non-root user
USER node

WORKDIR /app/packages/api

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
