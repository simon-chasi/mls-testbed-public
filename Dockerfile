# Multi-stage Dockerfile for the MLS testbed
# Stage 1: Build the Rust mls-cli binary
# Stage 2: Run the TypeScript simulator + Python analysis

# ── Stage 1: Rust build ────────────────────────────────────────────────────────
FROM rust:1.85-slim AS rust-builder

WORKDIR /build
COPY mls-cli/Cargo.toml mls-cli/Cargo.lock ./mls-cli/
COPY mls-cli/src ./mls-cli/src/

RUN cd mls-cli && cargo build --release

# ── Stage 2: Node.js + Python runtime ─────────────────────────────────────────
FROM node:20-slim AS runner

# Install Python via venv to avoid distro-managed-environment conflicts
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Create and activate a venv for Python dependencies
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Copy compiled Rust binary
COPY --from=rust-builder /build/mls-cli/target/release/mls-cli /app/mls-cli/target/release/mls-cli
RUN chmod +x /app/mls-cli/target/release/mls-cli

# Install Node dependencies (including devDeps for ts-node)
COPY simulator/package.json simulator/package-lock.json ./simulator/
RUN cd simulator && npm ci

# Install Python dependencies into the venv
COPY analysis/requirements.txt ./analysis/
RUN pip install --no-cache-dir -r analysis/requirements.txt

# Copy source
COPY simulator/tsconfig.json ./simulator/
COPY simulator/src ./simulator/src/
COPY analysis ./analysis/

# Pre-create output directories so volume mounts land as the node user, not root
RUN mkdir -p /app/logs /app/figures

ENV MLS_CLI_PATH=/app/mls-cli/target/release/mls-cli
ENV LOG_DIR=/app/logs
ENV FIGURES_DIR=/app/figures
