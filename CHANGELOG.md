# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/) and
Semantic Versioning.

## [Unreleased]

## [0.1.2] - 2026-07-31

### Added

- Cross-platform release, security scanning, SBOM, integrity, and smoke-test
  workflows.
- OpenAPI contract plus executable cross-cutting contract, security, and
  performance test suites.
- Consecutive AI tool calls now collapse into a categorized activity summary
  while preserving approvals, file diffs, failures, and per-tool details.

### Changed

- Full-workspace tests now use a CI-safe timeout for I/O-heavy integration
  scenarios while retaining per-test timeout protection.
- Windows setup and uninstall now use branded native NSIS pages and bitmap
  artwork; the risk notice no longer loads through HTML or EmbedHTML.
- Windows setup now starts with a language selector and renders only the chosen
  Chinese or English copy. Silent updates preserve that choice, and the
  uninstaller remembers the installed language.
- Installer artwork is deterministically generated from repository JavaScript
  at 3x resolution and rendered through DPI-aware native controls.
- The uninstaller keeps user data by default and provides an explicit,
  confirmation-gated option to permanently remove conversations, settings,
  plugins, and encrypted credentials.
- Desktop production archives now exclude tests, coverage reports, build
  caches, source maps, logs, and workspace source; release CI verifies the
  resulting ASAR and scans it for plaintext secrets.
- Docker build contexts now exclude local databases, encrypted credentials,
  logs, release artifacts, temporary user-data directories, and private keys.

## [0.1.1] - 2026-07-30

### Added

- Automatic conversation titles with manual-rename protection and live sidebar
  refresh across successful, failed, cancelled, and cached chat flows.
- Assisted Windows installer with an explicit risk notice, required acceptance,
  selectable installation directory, and a confirmation-first uninstaller.

### Changed

- Windows uninstall keeps local conversations, settings, and encrypted
  credentials by default to prevent accidental data loss.
- Release version validation now keeps desktop, Web, server, installer, and
  release metadata aligned.

## [0.1.0] - 2026-07-28

### Added

- Electron desktop, Web client, collaboration server, and shared React UI.
- OpenAI-compatible provider discovery, streaming chat, retry, queue, usage,
  and encrypted multi-key foundations.
- SQLite persistence for users, providers, keys, projects, conversations,
  snapshots, memories, usage, settings, and audit records.
- Plugin SDK/runtime with explicit permissions, isolated host process,
  integrity validation, lifecycle management, and development hot reload.
- Declarative bilingual Skills and dependency-aware Workflow orchestration.
- Authentication, RBAC, AES-256-GCM secret storage, redaction, structured
  logging, metrics, health checks, and graceful shutdown.
- Vitest workspaces, Playwright Web/Desktop journeys, Docker, Kubernetes,
  systemd, Prometheus, and three-platform release assets.
