# Build argument for multi-architecture support
ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.19
FROM ${BUILD_FROM}

# Set shell for pipefail
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install system dependencies
# Node.js 18+ is required for @peaq-network/sdk
# Python3 and build tools needed for native npm packages
RUN apk add --no-cache \
    nodejs>=18 \
    npm \
    python3 \
    py3-pip \
    make \
    g++ \
    git \
    curl \
    dos2unix

# Set working directory
WORKDIR /app

# Copy package.json first (for Docker layer caching)
COPY package.json ./

# IMPORTANT: Use 'npm install' instead of 'npm ci'
# npm ci requires package-lock.json which we don't have
# --omit=dev replaces deprecated --production flag
# --no-optional skips optional deps that may fail on ARM
RUN npm install --omit=dev --no-optional && \
    npm cache clean --force

# Copy application files
COPY rootfs /

# Strip Windows CRLF line endings (safety net for Windows-built images) and make executable
RUN dos2unix /run.sh && \
    chmod a+x /run.sh && \
    chmod a+x /app/*.js 2>/dev/null || true

# Set production environment
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"

# Health check - verify web UI is responding
HEALTHCHECK --interval=60s --timeout=15s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8099/api/health || exit 1

# Start the application
CMD [ "/run.sh" ]
