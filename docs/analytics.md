# Cloudflare Web Analytics

LaunchKit automatically configures basic, free Cloudflare Web Analytics after successful custom-domain binding. This uses the deployment account, saved zone and exact production hostname. No Google Analytics, custom backend, paid plan or subscription is added.

## Configuration and evidence

LaunchKit verifies the live zone belongs to the account, is active and unpaused, and has a proxied A, AAAA or CNAME record for the hostname. It paginates the account's analytics sites, reuses an exact-host match, and reads its detail before and after any update. It never chooses a site solely because it shares the zone.

New sites are staged with `auto_install: false`, their hostname rules are checked (or their newly created default rule narrowed), then `auto_install: true` and `enabled: true` are set. This avoids activating a zone-wide default on unrelated hostnames. Existing exclusion, path and regional settings are preserved. Existing wildcard, other-host, paused or ambiguous rules require review in Cloudflare rather than an automatic rewrite. A timed-out creation is recorded in the operation journal and reconciled before another request; an unresolved creation is not repeated.

The UI reports **Cloudflare Web Analytics: Enabled** only after the site detail confirms the exact hostname, zone, enabled ruleset and automatic installation. It links to that site's Cloudflare dashboard. Configuration success is separate from **browser tracking verified**: a bounded HTML probe checks for the beacon and blockers; when feasible, Chrome checks that the script loads and a collection POST for this site token succeeds. A successful check does not prove historic traffic or dashboard data availability. No beacon payload, visitor data or API credential is saved.

Analytics failure leaves the application deployed. Permission/API failures appear as a pending analytics step; unsupported deployments are skipped with a reason. The existing-deployment action preserves the saved deployment status, release and other steps.

## Credentials

Use the existing Cloudflare token. Account Settings Read authorizes list/detail operations; Account Settings Write authorizes creation/update. In the dashboard, the latter may be labeled Account > Account Settings > Edit. Restrict it to the deployment account. Existing Zone Read and DNS Read/Edit permissions supply the eligibility checks. Account Analytics Read alone is insufficient. No token-management permission or all-account access is requested.

A denied operation identifies the required permission and how to update/reconnect the token. Denials can also reflect expiration or resource restrictions; LaunchKit does not infer a full permission inventory from token verification. See [provider guidance](providers.md).

## Existing deployments

Restart LaunchKit after updating the code. Select your production domain in Saved businesses, then **Configure / recheck Web Analytics** in the launch progress card. This uses its existing credentials and deployment resources and executes only the analytics step. It does not build, deploy, change DNS or edit the application.

Alternatively, stop the local LaunchKit server to release its state lock, then run:

```powershell
node scripts/configure-web-analytics.ts example.test
```

Use the same `LAUNCHKIT_DATA_DIR` if the server uses a custom state location. The CLI holds the same exclusive operator lock as the server. It refuses ambiguous saved deployments; choose the intended business in the UI instead. Re-running either path reuses the existing analytics site.

## Blockers requiring review

- **Cache-Control: no-transform** prevents Cloudflare injection. Older LaunchKit Workers add it. The analytics-only action reports it but does not redeploy. Removing that hosting header requires a Worker update (for example a normal LaunchKit launch with the current wrapper), or an appropriate response-header policy change. Application-supplied no-transform remains intact.
- **Content Security Policy** can block the beacon. Allow `https://static.cloudflareinsights.com` in the effective `script-src`/`script-src-elem` and allow the same-origin `/cdn-cgi/rum` endpoint in `connect-src`. Both response headers and HTML meta policies apply. LaunchKit reports likely blockers and does not relax application CSP automatically; review and change the authoritative policy if tracking is desired.
- **DNS-only, inactive/paused zones and preview hostnames** do not qualify for automatic installation. Review proxy settings or install Cloudflare's snippet manually where appropriate. LaunchKit does not alter DNS for analytics.
- **Existing custom rules, EU exclusions, propagation and browser blockers** can prevent a particular check from producing a beacon. Existing settings are retained; use the dashboard to review them and recheck afterward.
- **Legacy isolated analytics deployments** are not silently switched by the analytics-only action, to avoid duplicate measurement. A normal launch prepares a fresh publication without the legacy iframe and enables automatic setup afterward. The old `analytics.approved` and `publicPaths` configuration fields are retained for journal compatibility, but no longer opt live deployments into the old isolated policy. Automatic Cloudflare injection runs on the production page and does not provide that former isolation/path-filter guarantee.

## Official API references

- [List sites and read permissions](https://developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/list/)
- [Create a site and write permission](https://developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/create/)
- [Update automatic installation](https://developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/update/)
- [Update a hostname rule](https://developers.cloudflare.com/api/resources/rum/subresources/rules/methods/update/)
- [Data collection and CSP](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/)
- [Injection limitations](https://developers.cloudflare.com/web-analytics/faq/)
