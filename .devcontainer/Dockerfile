# Dev container image for GazingEngageMent.
#
# Contains both Python (backend) and Node.js (frontend) toolchains. Built once
# and reused across rebuilds; dependency installation happens inside the
# named volumes mounted by docker-compose (see docker-compose.yml), so the
# host folder stays clean.

FROM mcr.microsoft.com/devcontainers/python:3.12-bookworm

ARG NODE_VERSION=24

# Install Node.js via NodeSource. We avoid `nvm` because the devcontainer
# already runs as the `vscode` user and we want node on $PATH for everyone.
USER root
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# `make` is needed for the project Makefile and isn't in the slim base.
RUN apt-get update \
    && apt-get install -y --no-install-recommends make \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Ensure the unprivileged `vscode` user owns the volume mount points so that
# `pip install` and `npm install` work without sudo.
RUN mkdir -p \
    /workspaces/GazingEngageMent/backend/.venv \
    /workspaces/GazingEngageMent/frontend/node_modules \
    /home/vscode/.npm \
    /home/vscode/.cache/pip \
    && chown -R vscode:vscode \
        /workspaces \
        /home/vscode/.npm \
        /home/vscode/.cache

USER vscode

# Speed up pip and surface progress in CI logs.
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=0 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /workspaces/GazingEngageMent
