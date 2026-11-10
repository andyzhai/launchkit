# Contributing

Use Node 24.x, npm, and installed Google Chrome. Run `npm ci` from this repository. No private repository or reference application is required for the default checks. LaunchKit runs TypeScript directly through Node; it has no separate build command.

## Source map

| Directory | Responsibility |
|---|---|
| `src/main.ts`, `src/ui/` | Local process, HTTP UI/API, business selection, and scheduling coordination |
| `src/workflow/` | Journal, approval records, deterministic launch steps, and recovery |
| `src/security/` | Configuration validation, redaction, and credential storage |
| `src/adapters/` | Application preparation and Cloudflare, domain, email, SEO, and analytics integrations |
| `src/verification/` | HTTP/browser checks and analytics evidence |
| `src/operate/` | Local monitoring, incident handling, and recovery coordination |
| `src/operate/cloud/` | Customer-owned monitor controller, Worker, and durable state |
| `src/grow/` | Google/Bing connections, public audits, restricted rendering, title improvements, and social publishing |
| `tests/`, `tests/browser/` | Synthetic unit/API/provider tests and Chrome browser tests |
| `scripts/` | Public hygiene, optional reference verification, and opt-in operational tools |

## Checks

| Command | Purpose |
|---|---|
| `npm run typecheck` | TypeScript checks |
| `npm test` | Unit/API/provider tests using synthetic data and transports |
| `npm run check` | Type checks followed by unit tests |
| `npm run test:browser` | Chrome UI, process restart, rendering, and analytics tests |
| `npm run check:public` | Staged-file listing and heuristic content/path scan, including untracked candidates |
| `npm run test:reference -- /absolute/path/to/your-vite-app` | Optional caller-supplied application install/tests/build, Wrangler dry-run, and local HTTPS verification |

Run unit and browser suites sequentially to avoid unnecessary resource contention. For a focused check, use `node --test tests/journal.test.ts` or another relevant test file. Add tests for meaningful uncovered behavior rather than duplicating existing assertions.

Tests create synthetic journals in temporary directories and use disposable browser contexts. Clear inherited provider credentials and `LAUNCHKIT_*` overrides before testing; use a fresh temporary `LAUNCHKIT_DATA_DIR` for any manual simulation. Keep normal operator processes and their state separate. Do not start `npm start` against existing state as a test: saved monitoring or readiness checks may resume.

Browser screenshots and results go to ignored `test-results/`. Keep additional diagnostics in ignored `artifacts/`. Dependencies, caches, build outputs, browser profiles, logs, and runtime journals must remain ignored. Temporary test directories may remain after tests and can be removed once no test process uses them.

The optional reference verifier runs scripts from the explicitly supplied application, so use a trusted disposable fixture for development. It writes under the platform application-data verification directory; `LAUNCHKIT_DATA_DIR` does not override that script's output path. It is not part of the default checks and does not deploy or purchase resources.

## Behavior to preserve

Keep provider changes typed and deterministic. Record intent before a mutation and reconcile unknown outcomes before any repeat attempt. Configuration changes must invalidate relevant approvals while preserving operation history. Do not erase journals to recover an unknown purchase or publication outcome.

Preserve exact Host/origin/session/CSRF checks, credential redaction, Windows credential protection, and public-network restrictions. Keep monitoring observations separate from historical launch evidence. Preserve the distinction between provider acceptance, externally observed configuration, and delivery confirmation.

Public auditing and rendering must retain their restricted transport, resource limits, and separate static/rendered evidence labels. Publishing a title improvement or social post requires approval of the exact target and content. Startup, report reads, selection, and background monitoring must not grant new publication approval.

## Live checks and operational tools

The `test:live`, `test:grow:live`, `test:bing:live`, and `test:social:live` scripts are explicit opt-in read-only probes. They are not required for contributions and must not run against another person's saved accounts. Their reports describe point-in-time observations, not release readiness or permission to mutate providers.

`scripts/configure-web-analytics.ts` can change provider configuration; it is an operational tool, not a test. Deployment, domain purchases, email drills, sitemap submissions, and social/title publication need their normal user authorizations. See the public guides linked from [README](README.md) for setup, recovery, and limitations.

Before an authorized commit, inspect the complete intended diff and staged file list, run `npm run check:public`, and check that generated data and private material are excluded. Never rely solely on `.gitignore` or the heuristic scan.
