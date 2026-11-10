# M3c Slice 2 — one approved title improvement

Growth can preview and publish one narrow metadata change: the homepage `<title>` and an existing `og:title`. Use the public audit's initial title, rendered headings and product-name review to decide whether a naming difference is intentional. This is a human decision; the feature does not invent a product name or declare a naming difference a search defect.

The customer owns the application source. LaunchKit copies the verified M1 publication and changes only supported title tags in `index.html`. It preserves every other distribution file, including robots, sitemap, scripts, styles and analytics assets. No source edit, build, dependency installation, DNS change, mail setup or analytics provisioning occurs. A future source release should retain the chosen title; the saved M1 SEO title is updated after successful release verification.

## Workflow

1. Select a production-bound business and explicitly refresh its public audit. A live proposal requires an M1-owned Worker, a saved verified final launch step, approved SEO, release/deployment identifiers, and an unchanged publication manifest. Unsupported or ambiguous title markup is refused.
2. Enter a factual homepage title and select **Preview title change**. Review exact before/after tags and the dated source evidence. This only creates a local publication copy. A new preview invalidates older pending previews. Titles are limited to 120 characters, escaped, and checked for credentials.
3. **Approve exact preview and publish to production** is a separate explicit action. Approval binds the business/configuration revision, current release/deployment, connection fingerprint, exact edits and artifact manifest. Previews expire after 24 hours. Modified artifacts, mismatched previews and stale business state cannot publish.
4. Preflight checks the existing Cloudflare Worker binding and deployment and verifies the baseline's public assets using M1's verifier. It then records durable publication intent before invoking M1's deployment helper for the existing Worker. The Worker release identifier changes along with the approved asset release. A Worker already bound to production updates production during deployment; this is not an isolated remote staging preview.
5. Select **Verify public release and audit (read-only)**. This checks the public release and all manifest assets, then repeats the same fixed-scope public audit. Before evidence is retained; the latest after evidence has its own time and result. These actions do not deploy. GET reports, downloads, reload, polling and ordinary audit refresh never publish.

## States and evidence

| State | Meaning |
| --- | --- |
| AWAITING_APPROVAL | Exact local preview is ready for review. |
| DECLINED / STALE | Cannot publish; prepare a new preview if needed. |
| FAILED | Pre-publication checks failed; no send was attempted. |
| INTENT / UNKNOWN | A send may have occurred. Only read-only reconciliation is allowed. |
| PUBLISHED | Deployment helper returned acceptance/evidence; separate production verification is still required. |
| VERIFIED | The expected public release and assets were observed. See the separately labeled audit result. |

After-audit results are **CORRECTED**, **REVIEW**, or **UNAVAILABLE**. CORRECTED requires an observed expected release and an exact expected initial HTML title. It does not establish better branding, factual accuracy, rendering behavior, ranking, visits, retrieval, training or AI citations. A JavaScript application may override the title; rendered metadata remains separately visible for review. Repeated verification replaces only the latest after observation, preserving the original before evidence and publication receipt.

Simulation uses synthetic audit evidence and a local fixture artifact, never Cloudflare or public networking. Its after-title observation is taken from that fixture, not a real site. Fixture tests and real public observations must remain distinct.

## Failure and recovery boundaries

The independent `grow-improvements/<business-id>.json` journal keeps at most 50 proposals and retains their reviewed content, approval time, intent and evidence. Publication copies live under `improvement-releases/`. The existing session/Origin protections and shared mutation guard apply. Pending publication blocks new proposals and launches targeting the same business/domain, including after restart. There is no automatic resend. A failed or absent read after an uncertain send is not proof the send failed; unresolved state requires operator investigation.

A receipt saved with the local launch update lets read-only verification finish after a crash between the launch and improvement journal writes. Re-verifying historical proposals does not roll back newer launch configuration. Once the release is verified, use the existing explicit cloud-monitor release sync if monitoring is enabled; publication does not silently change monitoring configuration.

The deployment helper and public asset verifier retain M1's behavior and limitations. Public audit rendering retains Slice 1's pinned-IP, bounded transport. Cloudflare deployment and public edge observations are not an atomic compare-and-swap: another actor can deploy concurrently outside this operator. Preflight rechecks the observed deployment and approval target; unexpected outcomes remain unresolved for review.

This slice deliberately excludes description editing, arbitrary HTML patches, robots-policy changes, application source editing, rollback automation, optional AI sampling and the M3d dashboard. Live provider publication must be separately authorized and verified; passing fixture tests does not establish live acceptance.
