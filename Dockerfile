# Build argument for multi-architecture support (HA Supervisor sets this).
ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.19
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Python 3.11 (Alpine 3.19 default), build deps for cryptography/aiosqlite,
# curl for the healthcheck, dos2unix as a CRLF safety net for Windows builds.
RUN apk add --no-cache \
        python3 \
        py3-pip \
        ca-certificates \
        curl \
        tzdata \
        dos2unix \
    && apk add --no-cache --virtual .build-deps \
        gcc \
        musl-dev \
        python3-dev \
        libffi-dev \
        openssl-dev \
        cargo \
        rust

WORKDIR /app

# Pinned runtime deps. cryptography is the heavy one — its wheels carry
# OpenSSL bindings used by the Fernet wallet vault.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
        aiomqtt==2.3.0 \
        aiosqlite==0.20.0 \
        fastapi==0.115.5 \
        uvicorn[standard]==0.32.1 \
        pydantic==2.10.3 \
        cryptography==43.0.3 \
    && apk del .build-deps

# Copy addon payload (Python hub + dashboard + run.sh).
COPY rootfs /

RUN dos2unix /run.sh && chmod a+x /run.sh

ENV ELP_DB_PATH=/data/elp.sqlite \
    DASHBOARD_DIR=/app/dashboard \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Hub HTTP + WebSocket (dashboard, REST, vault) and dashboard static files.
EXPOSE 8099

HEALTHCHECK --interval=60s --timeout=15s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:8099/api/health || exit 1

CMD ["/run.sh"]
