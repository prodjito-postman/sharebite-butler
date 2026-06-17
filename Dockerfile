# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN bun install

# Copy source
COPY . .

# Runtime stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/agent ./agent
COPY --from=builder /app/ingestion/lib ./ingestion/lib
COPY --from=builder /app/package.json ./

# Sharebite office timezone. The container clock is UTC on EKS, so pin this
# explicitly — both the agent's today/tomorrow logic and the Sharebite API
# params resolve against it. Override at deploy time for a different office.
ENV SHAREBITE_TIMEZONE=America/Los_Angeles

# Use non-root user already present in oven/bun image (bun:1000)
RUN chown -R bun:bun /app
USER bun

# Run the agent
CMD ["bun", "run", "agent/index.ts"]
