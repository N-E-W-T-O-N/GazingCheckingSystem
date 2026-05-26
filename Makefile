# GazingEngageMent — developer cheatsheet
#
# Two kinds of targets here:
#   1. App targets  (run inside the devcontainer, or natively if you have
#      python+node installed). They operate on the backend and frontend.
#   2. Container targets (run on the HOST). They wrap `docker compose` so you
#      don't need to remember the flags.
#
# Quick start (host):
#     make container-up           # build + start the devcontainer
#     make container-shell        # open a shell inside
#     # then inside the container:
#     make install
#     make dev                    # runs backend + frontend together
#
# Note: .venv and node_modules live in named Docker volumes, NOT in the
# project folder. See .devcontainer/docker-compose.yml for the volume layout.

SHELL          := /usr/bin/env bash
.SHELLFLAGS    := -eu -o pipefail -c
.DEFAULT_GOAL  := help

BACKEND_DIR    := backend
FRONTEND_DIR   := frontend
VENV           := $(BACKEND_DIR)/.venv
PYTHON         := $(VENV)/bin/python
PIP            := $(VENV)/bin/pip
UVICORN        := $(VENV)/bin/uvicorn

COMPOSE        := docker compose -f .devcontainer/docker-compose.yml

# ──────────────────────────────────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────────────────────────────────

.PHONY: help
help:  ## Show this help.
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ──────────────────────────────────────────────────────────────────────────
# App targets — run these INSIDE the devcontainer
# ──────────────────────────────────────────────────────────────────────────

.PHONY: install
install: install-backend install-frontend  ## Install backend + frontend deps.

.PHONY: install-backend
install-backend:  ## Create venv (if missing) and install Python deps.
	@if [ ! -x "$(PYTHON)" ]; then \
		echo "→ creating venv at $(VENV)"; \
		python3 -m venv $(VENV); \
	fi
	$(PIP) install --upgrade pip
	$(PIP) install -r $(BACKEND_DIR)/requirements.txt

.PHONY: install-frontend
install-frontend:  ## Install Node deps.
	cd $(FRONTEND_DIR) && npm install

.PHONY: backend
backend:  ## Run the FastAPI backend on :8000 (reload mode).
	cd $(BACKEND_DIR) && ../$(UVICORN) app.main:app --reload --host 0.0.0.0 --port 8000

.PHONY: frontend
frontend:  ## Run the Vite dev server on :5173.
	cd $(FRONTEND_DIR) && npm run dev -- --host 0.0.0.0

.PHONY: dev
dev:  ## Run backend + frontend together. Ctrl-C stops both.
	@echo "→ starting backend (:8000) and frontend (:5173)"
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) backend & \
	$(MAKE) frontend & \
	wait

.PHONY: typecheck
typecheck:  ## Static checks: tsc --noEmit + python syntax compile.
	cd $(FRONTEND_DIR) && npx tsc --noEmit
	$(PYTHON) -m compileall -q $(BACKEND_DIR)/app

.PHONY: build-frontend
build-frontend:  ## Production build of the SPA.
	cd $(FRONTEND_DIR) && npm run build

.PHONY: clean
clean:  ## Remove build outputs (deps are in named volumes — use container-reset).
	rm -rf $(FRONTEND_DIR)/dist
	rm -f $(BACKEND_DIR)/engagement.db
	find $(BACKEND_DIR) -type d -name __pycache__ -exec rm -rf {} +

# ──────────────────────────────────────────────────────────────────────────
# Container targets — run these on the HOST
# ──────────────────────────────────────────────────────────────────────────

.PHONY: container-up
container-up:  ## Build (if needed) and start the devcontainer in the background.
	$(COMPOSE) up -d --build

.PHONY: container-down
container-down:  ## Stop the devcontainer (keeps volumes).
	$(COMPOSE) down

.PHONY: container-shell
container-shell:  ## Open an interactive bash shell inside the container.
	$(COMPOSE) exec dev bash

.PHONY: container-logs
container-logs:  ## Tail the container's logs.
	$(COMPOSE) logs -f

.PHONY: container-reset
container-reset:  ## Wipe and rebuild dependency volumes (deletes .venv + node_modules).
	$(COMPOSE) down -v
	$(COMPOSE) up -d --build
	$(COMPOSE) exec dev make install
