# CI/CD

All workflows live in `.github/workflows/` and start working once the project is pushed to GitHub.

| Workflow | Runs on | What it does |
|---|---|---|
| `ci.yml` | push to main, pull requests | Typecheck, unit tests on Node 22 and 24, database tests against a Postgres 16 service, Docker build, compose validation, and a smoke test of the built image (including clean shutdown) |
| `release.yml` | tags like `v1.2.0` | Runs `ci.yml` as a gate, publishes a multi-arch image to GitHub Container Registry, then creates a GitHub release with generated notes |
| `codeql.yml` | push, pull requests, weekly | Security scanning for JavaScript and TypeScript |
| `dependabot.yml` | weekly | Update pull requests for npm, Docker, and GitHub Actions |

## First-time setup

1. `npm install` once locally and commit `package-lock.json` (CI uses `npm ci`).
2. Push to GitHub. CI runs on the first push.
3. To release: `git tag v1.0.0 && git push origin v1.0.0`. The image appears under the repository's Packages.
4. Suggested repository settings: require the CI jobs to pass before merging to `main`.

These files were written without being run on GitHub, so the first run may need small fixes.
