# Provider connections

Use customer-owned accounts. The UI stores connections once and reuses them. Never paste credentials into issues, reports, source code or chat.

## Cloudflare

Create an API token limited to the selected account and zones. Typical capabilities are Account Settings Read (account discovery and Workers subdomain), Workers Scripts Edit (deploy and custom domains), Zone Read, DNS Edit and Workers Routes Read/Edit for conflict inspection. Email Routing needs address and rule access plus **Zone Settings Write** for the DNS-enable endpoint. Web Analytics provisioning currently requires **Account Settings Write**, not merely Analytics Read. Permission names in the dashboard can differ from API labels; use the endpoint's official accepted permissions and narrow resource restrictions.

LaunchKit checks account and zone read access first. It does not claim to prove all write scopes from token validity: each endpoint can independently report a missing permission. There is no universal all-account token requirement. The main token is used for deployment, DNS, email routing and automatic Web Analytics; a separate Registrar token is accepted for registration. Further per-capability token separation is a future improvement.

Registrar requires an entitled account, the appropriate user token, a default payment profile, default registrant contact and acceptance of the registration agreement. Account-owned tokens are not universally supported by all APIs. If registration access is missing, the UI provides the account's registration page and resumes after setup or an external registration. Unsupported or premium domains are never guessed or automatically bought.

An existing active Cloudflare zone is reused. For newly registered domains, LaunchKit inspects or creates the zone and waits for authority. For domains held at another registrar, changing nameservers is an unavoidable external action until that registrar is supported and authorized. Existing web records and incompatible MX/SPF records require explicit replacement approval. LaunchKit records their previous values.

A Workers account subdomain does not require an existing Worker. During the first launch, `GET /accounts/{account_id}/workers/scripts/{worker_name}/deployments` may return HTTP 404 with error 10007. LaunchKit treats that specific response as an absent Worker, creates it with Wrangler, then checks both the deployment record and the public release marker. Temporary absence after submission is a resumable propagation wait. Resume inspects the saved submission without deploying it again. Authentication errors and unrelated 404 responses still stop the operation; no manual Worker creation is required.

After custom-domain creation, LaunchKit checks public DNS, HTTPS, redirects and release assets. Network errors and temporary edge responses trigger bounded readiness retries, then a resumable provider wait. Diagnostics identify the hostname and transport error code. Resume reconciles existing bindings before writing; TLS certificate validation remains enabled throughout.

Web Analytics is enabled by default after supported custom-domain deployment. `GET /accounts/{account_id}/rum/site_info/list` and the site detail GET require **Account Settings Read**; creation and update require **Account Settings Write** (often shown as Account > Account Settings > Edit in the token editor). Limit account resources to the deployment account. Existing Zone Read and DNS Read/Edit scopes are used to verify zone ownership and proxy status. Account Analytics Read is for aggregate Worker usage and does not replace these permissions.

LaunchKit checks capabilities by making the required operations, without requesting token-management privileges. A read denial stops before any creation. A write denial names the required write permission and the token-editor correction; it does not block the application deployment. A 401/403 can also indicate expiry or incorrect account/zone scope, so LaunchKit does not claim it can enumerate a token's exact grants from that response. Save an updated token in Connect once and use **Configure / recheck Web Analytics**. Tokens and provider response bodies are never included in analytics reports.

New production Workers no longer add `no-transform`, but preserve any application-supplied header and CSP. Older deployments retain that header until their hosting response policy is changed. The analytics-only action does not redeploy or edit the application. See [Web Analytics](analytics.md) for blockers, legacy policy migration and existing-site instructions.

Relevant official references:

- [Registrar workflow and prerequisites](https://developers.cloudflare.com/registrar/registrar-api/)
- [Registrar sandbox](https://developers.cloudflare.com/api/resources/registrar_sandbox/) — separate test namespace, no real billing or DNS zones, full contact data required for registration
- [Attach Worker domain](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)
- [Email Routing DNS enable](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/)
- [Web Analytics site creation](https://developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/create/)
- [Account token compatibility](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

## Resend

Optional outbound setup requires an API key that can manage domains. LaunchKit uses `send.domain` so incoming apex MX records stay separate. It inspects existing domains, creates one when absent, installs required DKIM/SPF DNS, requests verification and checks the resulting status. Plan limits remain provider-controlled; LaunchKit never upgrades a subscription. Email sending, test messages and campaigns are not invoked.

[Resend domain API](https://resend.com/docs/api-reference/domains/create-domain) documents the records returned by the provider. These records are translated to fully qualified names within the sending subdomain and checked for conflicts before changes.

## Google Search Console (M3a)

Use a customer-owned Google Cloud Desktop OAuth client with Search Console API enabled. LaunchKit requests `https://www.googleapis.com/auth/webmasters.readonly` for property discovery, sitemap inspection and search reporting. Optional sitemap-management consent requests `https://www.googleapis.com/auth/webmasters`; each PUT still requires an exact local approval and owner/full-user access. No passwords, property-creation calls, DNS verification writes or billing changes are used. See [Grow setup and evidence limits](grow.md).

## Mastodon social publishing (M3c)

M3c social publishing uses a customer-owned mastodon.social user token with `read:accounts`, `read:statuses` and `write:statuses`. It is stored with the existing Windows DPAPI vault or supplied by `MASTODON_ACCESS_TOKEN`; no provider password, model credential or billing scope is needed. Each post requires exact content/account approval. See [social setup and limits](grow-social.md).

## Bing Webmaster Tools (M3b)

The supported JSON/HTTP connector uses a customer-owned Bing Webmaster API key, stored in the existing vault or supplied as `BING_WEBMASTER_API_KEY`. This key grants account-wide access and has no read-only scope. Reads are explicit; only exact approved submission of the verified M1 sitemap can write. Existing verified HTTPS sites are reused; account setup and missing ownership verification remain customer actions in Bing. No DNS or site-creation APIs are invoked. See [Bing setup, contracts and evidence limits](grow-bing.md).

## M2 usage and health

Public health and TLS checks do not need provider credentials. Optional Worker usage uses the saved Cloudflare token and requires **Account → Account Analytics → Read**, scoped to the business account. This is independent of the M1 Web Analytics provisioning permission. No broader token or paid upgrade is requested automatically.

LaunchKit sends a fixed read-only query to `POST /client/v4/graphql`, using `workersInvocationsAdaptive`, an exact `scriptName` filter, a 24-hour time window, and `sum { requests errors }` with no dimensions. GraphQL errors, unavailable datasets, absent samples, missing account access, and incomplete fields remain UNAVAILABLE. The hourly summary describes sampled Worker invocations; it is not an invoice, an exact billing counter, or a visitor count. Health probes themselves can contribute requests.

The query and permission requirements follow Cloudflare's [Worker metrics tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/), [single-Worker aggregate example](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/), and [Analytics API token setup](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/). Provider billing totals are not integrated.

## Cloud monitoring and email notifications

The customer-owned monitor uses Workers deployment/schedule access, SQLite Durable Objects, and existing Email Routing. The local token must permit account subscription inspection, zone ownership reads, verified email destination reads, Worker upload/secrets/subdomain/schedules, and creation of the monitor's Durable Object namespace. Missing permissions stop deployment with a provider error; no additional broad token is installed in the monitor. Its remote management secret cannot deploy Workers, modify DNS, buy anything, or access other account resources.

SQLite-backed Durable Objects are available on the Workers Free plan, with shared daily limits; exceeding free limits causes operations to fail. See [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). The controller does not upgrade plans and refuses accounts with paid/trial/unknown Workers subscriptions. It provisions one object and a five-minute trigger, keeps bounded state, disables observability log ingestion, and limits email attempts to 20 per UTC day. These are application safeguards, not a billing guarantee if an account is changed externally.

The `send_email` binding is restricted with `destination_address` to the already verified owner inbox. The sender is `monitor@<production-domain>` on the existing ready routing domain. Sending to verified destinations is free on Cloudflare's supported plans and does not require arbitrary-recipient sending or a paid upgrade. See [email pricing](https://developers.cloudflare.com/email-service/platform/pricing/) and [restricted send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/). No new MX, SPF or DKIM configuration is performed by monitoring.

The [Workers email binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) returns acceptance; LaunchKit separately verifies recipient receipt through an explicit confirmation link. It persists send intent and does not retry ambiguous sends, because the binding does not supply an idempotency-key contract. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and a [Durable Object alarm](https://developers.cloudflare.com/durable-objects/api/alarms/) supply scheduling and a missing-schedule watchdog. The watchdog is useful for a lost trigger but shares Cloudflare's platform and account limits; independent third-party outage detection is not claimed.
