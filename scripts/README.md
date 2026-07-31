# Release and quality scripts

These scripts use only Node.js built-ins and can therefore run before the
workspace dependencies are installed.

| Command                                                                   | Purpose                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `node scripts/ci/validate-workspace.mjs`                                  | Validate required files, root commands, licensing, and secret hygiene                                                   |
| `node scripts/test/run-coverage-gates.mjs`                                | Generate combined coverage and enforce every configured project threshold                                               |
| `node scripts/build/prepare-node-native.mjs`                              | Verify and, when necessary, repair the Node native-module ABI                                                           |
| `node scripts/build/build-production.mjs`                                 | Run type checking, linting, tests, and production builds                                                                |
| `node scripts/build/build-production.mjs --package-desktop`               | Also create the native desktop installer                                                                                |
| `node scripts/security/secret-scan.mjs`                                   | Scan source files without echoing suspected secret values                                                               |
| `node scripts/security/generate-sbom.mjs`                                 | Generate a CycloneDX 1.5 SBOM                                                                                           |
| `node scripts/release/create-release-manifest.mjs`                        | Create the machine-readable release manifest                                                                            |
| `node scripts/release/generate-checksums.mjs`                             | Create deterministic SHA-256 checksums                                                                                  |
| `node scripts/release/sign-artifacts.mjs`                                 | Sign the checksum file with an offline private key                                                                      |
| `node scripts/release/verify-artifacts.mjs`                               | Verify checksums and, when requested, the detached signature                                                            |
| `node scripts/smoke/smoke-web.mjs`                                        | Check API liveness/readiness and the Web entry page                                                                     |
| `node scripts/smoke/smoke-desktop.mjs --platform windows --version 0.1.2` | Validate that a native installer exists, is non-truncated, starts, and reports the expected version                     |
| `node scripts/smoke/verify-windows-installer.mjs --version 0.1.2`         | Read-only validation of the exact Windows installer version, PE metadata, uninstaller, license, and installer resources |

Private keys must be supplied at runtime with `E_AGENT_SIGNING_KEY` or
`E_AGENT_SIGNING_KEY_FILE`; they must never be placed in the repository.
