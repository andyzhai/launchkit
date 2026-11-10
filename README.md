# LaunchKit

LaunchKit is a local small-business operator. Select an existing application, choose a domain, connect customer-owned provider accounts, and click **Launch**. It runs deterministic build, hosting, domain, email, SEO, analytics and verification steps with saved progress and explicit approvals.

M1 supports a verified production launch with customer-owned Cloudflare hosting, custom domain, HTTPS, incoming email configuration and baseline SEO. M2 adds local and customer-owned cloud monitoring, incident/email alerts, triage, recovery through the launch workflow, and usage/cost summaries. Each run reports timestamped evidence and pending items; a passing simulation is not a live launch. LaunchKit is application-agnostic.

## Install and open

Install Node.js 24.x, npm, and Google Chrome (used for browser verification). Clone this repository, then:

```sh
npm ci
npm start
```

Open **http://127.0.0.1:4317**. The UI is bound only to loopback. Set `PORT` to change its port. Use a trusted local application: its npm install, test, build, and deployed-test scripts run with your OS user permissions.

## Launch

1. Select a local Node/Vite application with `package-lock.json`, `npm test`, `npm run build`, and output in `dist/`.
2. Enter the domain and the existing inbox that should receive `contact@domain`.
3. Connect a scoped Cloudflare API token in the local form. A separate Registrar token is needed only for registration. Connect Resend only if outbound email is selected.
4. Select the account. Review SEO metadata. Free Cloudflare Web Analytics is configured by default after custom-domain setup.
5. Click **Launch**. Review any exact-price purchase approval or existing-service replacement approval. Complete unavoidable provider account and inbox verification when prompted.

LaunchKit runs Wrangler, configures DNS and email, and checks public results. There are no normal customer-facing DNS or shell commands. Account signup, legal registrant consent, billing verification, or delegation at an unsupported external registrar may require provider interaction.

Choose **Simulation** to explore the entire workflow without cloud changes. Simulated URLs are not deployed websites. To adjust a saved business, select it, change preferences, and click Launch again; unchanged inputs resume the same business. Provider state is inspected on every attempt.

The result is **LIVE VERIFIED**, **LIVE PARTIALLY CONFIGURED**, **BLOCKED**, or **FAILED**. A partial result lists exactly what is pending. The launch report is downloadable from the UI and remains point-in-time evidence. Subsequent health results appear separately in Operate.

Unselected outbound email and unsupported automatic analytics are **SKIPPED**. Analytics configuration and browser tracking have separate evidence; analytics errors leave the website deployed and report an actionable pending item. Inbox verification and provider propagation are rechecked every 30 seconds while the local app is running, for up to ten automatic attempts per session; use **Resume / recheck** if the wait lasts longer. Rechecks reuse existing resources. Changing settings invalidates old action approvals while retaining the operation history needed for safe recovery.

## Operate after launch

Select a saved business and use **Check health now**, or enable periodic checks in **Operate**. The default interval is five minutes. Leave the local LaunchKit process running for scheduled checks; closing only the browser does not stop the process. Monitoring is off until enabled, and resumes from saved settings when the process restarts. Missed periods are unmonitored gaps, not measured uptime.

For monitoring while the laptop is off, use **Cloud monitoring** for a live saved business. Review the production hostname and verified owner inbox, authorize the settings, and select **Deploy / update cloud monitor**. A separate Cloudflare Worker, Cron Trigger and SQLite Durable Object perform read-only checks and send authorized incident/recovery emails. They receive no deployment credentials. Verify two real scheduled checks and the labeled email drill before treating delivery as operational. Cloudflare transport checks HTTPS validity; certificate-expiration warnings remain local. The UI also lets you disable monitoring, inspect stale/missing observations and acknowledge incidents.

Operate checks public DNS, validated HTTPS, certificate expiration, homepage status, the confirmed release marker, and baseline headers. It records **HEALTHY**, **DEGRADED**, **DOWN**, or **UNKNOWN**, with stale evidence labeled explicitly. Alerts are displayed locally, deduplicated by issue, and retained across restarts. Acknowledging an alert does not resolve it; a successful check does.

Transient recovery is confirmed by scheduled or manual rechecks without changing production. **Inspect and repair launch** runs the saved application's build and existing provider workflow, retaining purchase/replacement approvals and unknown-outcome reconciliation. It can pause for review; there is no automatic rollback or forced deployment. Recheck health afterwards to confirm recovery.

Optionally enable aggregate Worker usage with Cloudflare **Account Analytics Read** access. Usage is fetched at most hourly during checks, for the preceding 24 hours. It includes health checks and may be sampled; it is not unique visitors or a billing meter. Recorded launch costs retain their original evidence. Missing invoices and ongoing charges are shown as unavailable, never as zero. No extra browser tracking is installed.

Download the local operations report for timestamps, recent checks, incidents, usage, and recorded costs; inspect cloud observations and email evidence in the cloud panel. Cloud monitoring uses free-tier capabilities and email restricted to an existing verified destination. Paid/unknown Workers billing blocks deployment for review; shared limits and platform outages can interrupt checks. See [Operate behavior and limits](docs/operate.md).

## Grow with search and approved social posts (M3a–M3c)

Reopening LaunchKit restores your saved Windows connections and last selected business. With no saved selection, LaunchKit prefers a verified production deployment over incomplete drafts. Saved businesses label production, drafts and simulations separately; intentionally selecting a draft preserves it for later work. Selection is local UI state and never launches or redeploys anything. Empty credential fields keep saved credentials; the connection summary shows what was restored.

Select a bound business and use **Growth** to connect your customer-owned Google Desktop OAuth client, discover existing accessible properties, select one, and refresh sitemap and search-performance evidence. Reads use read-only consent by default. Submission of the existing verified M1 sitemap requires sitemap-management consent plus approval of the exact property and URL. Interrupted submissions are reconciled without blind retries.

The report distinguishes provider metrics, empty/unavailable data, sitemap processing and unimplemented indexing inspection. No model subscription is required. Google account authorization and any missing property verification require customer interaction. See [Grow setup, approvals and verification](docs/grow.md).

M3b adds **Bing Webmaster Tools**: save your API key, refresh verified HTTPS sites, select the matching site, and read sitemap status and daily clicks/impressions. Submitting the existing M1 sitemap requires exact approval and reconciles interrupted attempts. Bing rows cover multiple search surfaces and retain their provider dates; they are not combined with Google's web-only metrics.

Use **Public discoverability review** to inspect the production homepage, robots.txt and sitemap without provider credentials. Initial HTML and restricted JavaScript-rendered evidence are shown separately, alongside search-crawler policies, separate training controls, canonical metadata and sitemap observations. Product-content candidates come from rendered evidence and always require human review. Browser failures are UNAVAILABLE; JavaScript fallback messages are not product descriptions. Rendering reuses installed Chrome through Playwright and allows only bounded same-host JavaScript/CSS assets. The review is read-only and does not measure indexing or AI citations. Public changes require separate approval through the launch workflow. See [M3b setup](docs/grow-bing.md) and [M3c Slice 1 behavior and limits](docs/grow-discoverability.md).

Revised M3c Slice 2 adds **One approved title improvement** below the public audit. Preview an exact homepage title edit in a copy of a verified M1 release, explicitly approve publication to its existing Worker, then separately verify the public release and before/after audit. Changed or stale previews cannot publish; uncertain sends are never automatically repeated. See [title improvement workflow and limits](docs/grow-improvements.md). Live publication requires a verified baseline and customer approval.

The original M3c **Social publishing** prototype remains available for your customer-owned **mastodon.social** account. Save editable drafts or create a website announcement from saved business metadata. Review the exact text, visibility and account before approving each post. Changes invalidate pending approvals; interrupted or uncertain sends remain blocked until read-only reconciliation by provider post ID. History distinguishes acceptance from observed source evidence and never claims audience reach. No AI subscription is needed. See [social setup and limits](docs/grow-social.md). A combined growth dashboard is not provided.

## Connections and safety

On Windows, credentials are encrypted using DPAPI for the current OS user and saved outside the repository. Other operating systems retain entered credentials in memory; environment credentials can be supplied by a user-managed secret store. No plaintext fallback is written to disk. See [provider setup](docs/providers.md) for scopes and prerequisites.

Runs, releases, approvals and reports are stored under `%LOCALAPPDATA%/LaunchKit` on Windows or `~/.local/share/LaunchKit` elsewhere. `LAUNCHKIT_DATA_DIR` can select another private location outside repositories. Back up this directory: losing approval and purchase-intent history requires manual reconciliation.

Purchases require approval of the exact domain, amount, currency, one-year term and legal terms. The quote is checked again before submission. An ambiguous purchase result is never automatically resubmitted. No paid-plan upgrades or outbound test messages are performed. Existing web DNS, MX records or routing rules are not silently replaced. Pre-change snapshots remain in the local journal for recovery.

## Supported capabilities and limits

- Node/Vite builds with locked npm installs, project tests, optional distribution audit, and release hashes.
- Customer-owned Cloudflare Workers Static Assets, preview noindex protection, custom domains, HTTP redirects, public DNS and HTTPS checks, and safe www redirects.
- Cloudflare Registrar check/search/registration with scoped access; sandbox API support for integration tests. Provider entitlement and registrant prerequisites apply.
- Cloudflare inbound forwarding with verified destination and public MX checks. This verifies configuration, not message delivery to an inbox.
- Optional Resend domain verification on `send.domain`; the launch workflow sends no Resend email.
- Approved canonical URL, sitemap, robots and factual metadata. No indexing or ranking guarantee.
- Automatic, free Cloudflare Web Analytics for supported proxied custom domains, with exact-host rule checks, reuse of existing sites, separate configuration/browser verification, and a Cloudflare dashboard link. See [analytics setup and existing deployments](docs/analytics.md).
- Application-specific synthetic verification uses `npm run test:deployed -- <https-url>`. Applications without this script remain partially verified.

New production Workers permit Cloudflare injection while preserving application-defined CSP and cache headers. Preview and legacy isolated responses still prevent injection. Analytics configuration can succeed while CSP or `Cache-Control: no-transform` blocks tracking; LaunchKit reports those separately. A successful beacon response verifies only that check, not the availability of traffic reports. Provider configuration, delivery, and live acceptance must be established for each deployment; automated checks do not establish those outcomes.

Use timestamped evidence from your run to establish its live status. Automated search-provider ownership verification, arbitrary external registrar APIs, custom feature-event analytics, full billing integration, and automatic rollback are outside the current implementation.

## Development and contribution

```sh
npm run check          # TypeScript and deterministic acceptance/provider tests
npm run test:browser   # Chrome UI and isolated analytics tests
npm run test:reference -- /absolute/path/to/your-vite-app
npm run test:live      # Skips unless explicitly enabled; read-only checks
npm run test:grow:live # Opt-in read-only Google acceptance checks
npm run test:bing:live # Opt-in read-only Bing acceptance checks
npm run test:social:live # Opt-in read-only Mastodon acceptance checks; never posts
npm run check:public   # Exact staged file list and heuristic secret/hygiene scan
```

The reference command runs locked install/build/tests, Wrangler dry-run, and local HTTPS browser verification with synthetic fixtures and mocked analytics transport. It does not deploy or purchase anything. For live read-only checks set `LAUNCHKIT_LIVE_READ_ONLY=1`, `CLOUDFLARE_ACCOUNT_ID`, and connect credentials. `LAUNCHKIT_REGISTRAR_SANDBOX=1` additionally checks sandbox domain availability, without registering a domain.

Contributions should keep provider mutations typed and deterministic, add meaningful failure/reconciliation tests, and document permission changes. Read [Contributing](CONTRIBUTING.md) for the source map, checks, and security invariants. Never commit internal engineering documents, tokens, local state, browser artifacts, or execution logs. Before a commit, review `git diff --cached --name-only` and run the public hygiene check. The scan is a heuristic; review the actual diff too. License: [MIT](LICENSE).
