# Milestone 2 — Operate

M2 supports local monitoring and an optional customer-owned cloud monitor. Local monitoring, incident triage, recovery, and usage/cost summaries remain available. Cloud monitoring continues when the laptop is off using a separate Cloudflare Worker, a Cron Trigger, and one SQLite-backed Durable Object. It does not modify the production application.

## Cloud monitoring

Select a live saved business and use **Cloud monitoring**. The first supported deployment is the existing PDF Redactor business. The monitor is reusable for a business whose production apex is an active Cloudflare zone owned by the selected account, with an existing verified owner inbox and ready Email Routing.

1. Review the displayed production hostname and owner inbox. Choose checks every 5, 15, 30, or 60 minutes, enable monitoring, select email notifications, and authorize the displayed scope.
2. Click **Deploy / update cloud monitor**. LaunchKit deploys a separate Worker, creates its SQLite Durable Object, restricts its email binding to the saved inbox, and inspects the resulting endpoint and schedule. It does not change website hosting, DNS, email routing, or subscriptions.
3. Wait for a real scheduled observation. Cron configuration can take time to propagate. A deployed script or manually fetched status is not evidence that scheduling works.
4. Click **Verify notifications on next schedules (2 emails)**. Two separate real Cron invocations send a clearly labeled incident/recovery drill. Open each email's receipt link and click **Confirm receipt**. The drill does not manufacture an outage on the production website. Provider send acceptance and confirmed inbox receipt are separate statuses.
5. Use **Save cloud settings**, **Disable cloud monitoring**, and **Refresh cloud status** to manage and inspect it. Cloud status also refreshes once per minute while selected in the local UI. Acknowledgement does not resolve a cloud incident. Disabling stops health probes, emails, and the watchdog; the configured Cron remains a harmless no-op, and state is retained.

The Worker receives a fixed authorized hostname, confirmed release baseline, and email destination. HTTP requests cannot add targets or forge scheduled events. It has no Cloudflare deployment, DNS, registrar, or billing credentials. Its management credential permits only monitoring configuration, status, acknowledgement, delivery verification, and reconciliation of a verified release on the same hostname. Windows saves the local management seed with DPAPI; other systems require a persistent 64-character hexadecimal `LAUNCHKIT_MONITORING_KEY` supplied through a secret store. Back up the existing state directory and credential store.

Cloud checks cover the HTTPS root response, HTTP status, release marker, and baseline security/indexing headers. DNS reachability and HTTPS validation use Cloudflare's fetch transport. The Workers API does not expose the peer certificate's expiration date: advance-expiry warnings remain in the local checker. Redirects are not followed, no response bodies are retained, and no application/user data is sent in notifications. Cloud health is distinct from the full application synthetic verification performed at launch.

Cloud state retains 48 observations, 32 resolved incidents plus open incidents, 80 events, and 80 notification records. The same incident reconciliation logic is used locally and in cloud. Each incident transition queues one alert and each observed recovery queues one recovery email. Cron replays and alarm retries cannot resubmit a recorded email attempt. Because the email binding does not provide a send-idempotency contract, attempts are persisted before calling it: ambiguous failures or interruptions become **UNKNOWN** and are never automatically resent. This favors avoiding duplicates over guaranteed delivery; inspect the inbox/provider when UNKNOWN appears. A limit of 20 attempts per UTC day bounds flapping alerts; suppressed emails remain visible in the report.

A Durable Object alarm watches for missing Cron invocations and observations, allowing a scheduling incident to be reported even while the local computer is off. Initial activation allows 20 minutes for propagation; later Cron gaps over 11 minutes are flagged. Results older than twice the configured check interval plus two minutes are stale. The watchdog records a single incident for a continuing gap and resolves it after a completed scheduled observation. A wider Cloudflare outage or exhausted shared limits can stop both the monitor and its watchdog/email; the UI labels unreachable or stale evidence explicitly. No uptime percentage or availability guarantee is inferred.

The default uses free-tier capabilities and free email to an already verified destination. The deployer refuses paid/trial/unknown Workers subscriptions and never buys or upgrades anything. Shared account limits can still interrupt monitoring. If the customer changes the account plan externally, billing follows that plan; this implementation does not supply a billing cap or paid-plan automation.

After a LaunchKit production launch completes full verification, the local operator updates an existing monitor's expected release. Failed, partial, preview-only, or pending deployments cannot advance the baseline. The cloud monitor independently checks HTTPS, HTTP success and the new release marker before saving it; it cannot change the authorized hostname or inbox. History, incidents, delivery confirmations and notification deduplication are retained. Any existing release incident resolves only on a subsequent successful scheduled observation. An in-progress deployment may therefore still produce a release-drift alert before final verification completes.

Interrupted or unavailable synchronization remains visible in cloud status. **Retry release sync** rechecks the saved successful launch and current cloud baseline without redeploying the application or sending notification drills. Status refreshes never change the baseline. Monitors installed before release reconciliation was supported need an explicit **Deploy / update cloud monitor** once to install it; future verified application releases do not require monitor redeployments. Monitor deployment itself also requires a fully verified production launch.

## Local monitoring workflow

1. Select a business that has a bound production URL. Existing M1 businesses work without migration.
2. Click **Check health now** for an immediate read-only observation, or enable periodic checks and save the interval. Monitoring defaults to off, with a suggested five-minute interval.
3. Review the latest timestamp, individual checks, and alerts. Acknowledge an alert to record that it has been seen. This does not mark the service recovered.
4. Let scheduled rechecks detect transient recovery, or check manually. For persistent configuration issues, **Inspect and repair launch** reruns the saved application's build and provider workflow. Existing approvals still apply. Recheck health to confirm the outcome.
5. Optionally collect aggregate Worker usage, and download the operations report for evidence.

The LaunchKit process must remain running for scheduling. It checks for due work every 30 seconds and serializes it with launch/recovery operations. Closing the browser leaves monitoring running; stopping the process stops monitoring. On restart, saved schedules resume without replaying every missed interval. Checks delayed by more than one full interval past their due time record a gap. Results older than two configured intervals are labeled stale. No uptime percentage is computed.

## Checks and triage

| Check | Observation | Failure behavior |
| --- | --- | --- |
| DNS | Production hostname resolves to public addresses | DOWN; private/reserved addresses are rejected before connection |
| HTTPS | TLS connection with trusted certificate and matching hostname | DOWN; validation is never disabled |
| Certificate | Certificate expiry read from the validated connection | WARN at 21 days or less; FAIL at 7 days or less; unreadable expiry is UNKNOWN |
| HTTP | Homepage GET returns 200 | DOWN; redirects are reported, never followed |
| Release | Header matches the last confirmed deployed release | DEGRADED on drift; missing baseline or unsuccessful HTTP is UNKNOWN |
| Headers | `nosniff`, `no-referrer`, and no production `noindex` header | DEGRADED on drift; unsuccessful HTTP is UNKNOWN |

The overall result is DOWN for a failed DNS/HTTPS/HTTP check, otherwise DEGRADED for any warning/failure, UNKNOWN for incomplete evidence, or HEALTHY when every check passes. A certificate that is already invalid fails the TLS connection. These are root-page checks from this computer; they do not replace the full launch asset audit, application synthetic tests, email checks, or analytics verification.

Each warning or failure creates a local dashboard alert with a diagnosis and suggested next action. Repeated observations update one open incident per check. A successful check resolves only that check's incident. An UNKNOWN observation does not resolve an existing incident. Escalation from warning to failure clears acknowledgement. Historical incidents distinguish first/last observation, acknowledgement, and observed recovery; they do not infer the precise beginning or end of an outage.

The operations journal retains 288 checks, 100 resolved incidents, all open incidents, and 200 events. Download reports to retain longer history. The process uses atomic writes and the existing redaction layer outside the repository. No response bodies, user content, or raw provider errors are retained. Simulation uses deterministic fixtures and makes no monitoring or usage network calls.

## Recovery boundary

Scheduled monitoring performs read-only checks. Transient DNS, edge, or network recovery can be confirmed on the next interval without modifying any provider resource. Checks have bounded deadlines; persistent failures remain open incidents instead of starting a repair loop.

The explicit repair action records an audit event and uses M1's runner. It may run the application's local build scripts and configure providers. Purchases require their exact-price approvals; conflicting DNS/email or existing deployment replacements retain approval and reinspection rules. Unknown mutation outcomes remain reconciliation blockers. A previously submitted release is never force-redeployed just to clear an alert. Automatic rollback, certificate replacement, and arbitrary shell recovery are outside M2. Health incidents resolve only after a separate successful observation, not merely because the repair workflow completed.

## Usage and costs

Optional Cloudflare usage requires Account Analytics Read and is fetched at most once per hour during health checks. The summary covers the preceding 24 hours for the exact Worker and reports requests and errors. It may be sampled and includes health probes; it is neither unique visitors nor a billing meter. The fetched timestamp and window remain visible even when monitoring is paused. Saving usage preferences resets the collection schedule; a missing permission or data response is shown as UNAVAILABLE and does not make the website unhealthy.

The cost section displays the launch journal's recorded registration quotes and completion/reconciliation evidence, including quoted renewal values when present. Actual invoices, taxes, subscriptions, and ongoing charges are unavailable. No costs recorded means no local evidence, not a zero bill. M2 does not upgrade plans, purchase resources, or install tracking. Authorized cloud monitoring emails are sent only to the verified owner inbox.

## Validation

`npm run check` covers scheduling/restart/gaps, pause/manual checks, incident deduplication and acknowledgement, warning escalation, unknown outcomes, redaction/retention, request authentication, concurrency, recovery approvals, private-address rejection, TLS error classification, release drift, and usage API contracts. `npm run test:browser` exercises the Operate dashboard, alert resolution, saved settings, report download, and mobile layout in Chrome.

Cloud tests additionally cover Cron replay, durable notification attempts across interruption, watchdog gaps/recovery, disabled behavior, receipt confirmation, fixed-target fetching, endpoint authentication, deployment ownership, partial-upload reconciliation, and free-tier gating. The cloud UI is exercised in Chrome. Live verification requires actual scheduled evidence and notification delivery, recorded in the cloud status; a passing simulation cannot satisfy that requirement. Keep generated reports and captured account data outside version control.
