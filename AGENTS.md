# Contributor and agent instructions

This is the public LaunchKit application repository. Keep application source, tests, synthetic fixtures, tooling, licensing, and public usage/contributor documentation here. The project must remain usable and testable without another repository.

- Read `CONTRIBUTING.md` for commands and the source map. Use Node 24.x and `npm ci` with the pinned lockfile. Do not upgrade dependencies as incidental cleanup.
- Prefer small, readable changes. Preserve journal compatibility, explicit approvals, provider intent/reconciliation, credential protection, retry limits, and recovery behavior unless the task explicitly changes them.
- Run appropriate existing checks and report actual outcomes. Automated simulation is not live-provider acceptance.
- Use synthetic data, temporary state directories, and disposable browser contexts. Never use a personal browser profile or existing production state for automated tests.
- Keep generated artifacts, logs, credentials, captured account data, and runtime state out of Git. Never copy provider response bodies or secrets into issues or reports.
- Internal architecture, detailed design, plans, and verification reports belong in the paired private engineering repository when available. Public workflows must not read or write sibling repositories implicitly.
- Keep the historical `internal-launchkit` repository unchanged. Refactoring and production rollout are separate tasks from repository organization.
- Do not commit, push, configure remotes, or change visibility without authorization. Review intended files and run the public hygiene check before an authorized commit; its scan is only a heuristic.
