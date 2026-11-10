# Grow — M3a: Google Search Console

Growth adds on-demand Google property discovery, sitemap inspection, final web-search reporting and approval-gated submission of the existing M1 sitemap. It uses the local operator and your provider account. No paid model or new hosted service is required. [M3b](grow-bing.md) adds Bing and public discoverability review. [M3c](grow-social.md) adds approved Mastodon publishing. A combined growth dashboard is not provided.

## Connect and inspect

Select a saved, bound business and open **Growth → Connect Google Search Console**. Use your own Google Cloud project with Search Console API enabled and a **Desktop app** OAuth client. The UI links to Google's API and client setup pages. Configure the OAuth consent screen; if the app is in testing, add your Google account as a test user. Enter the client ID and client secret in the local form, or supply `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` through your environment. These identify the application; never enter your Google password into LaunchKit.

Click **Prepare Google sign-in**, then follow **Continue to Google sign-in in your browser**. Sign in and consent on Google. The default requests only `webmasters.readonly`. A Desktop client uses a loopback callback with random state and PKCE; links expire after ten minutes or a process restart. Return to LaunchKit after consent. If another local operation prevented the callback, start sign-in again once it finishes. A new connection supersedes the previous Google account for all businesses; cached evidence and pending approvals from that connection cannot be used as current evidence or authority.

Windows saves the refresh token and client configuration in the existing user-protected DPAPI vault outside the repository. Access tokens stay in memory. Other operating systems retain the connection only in memory; reconnect after restarting. Google may expire or revoke authorization, especially for a project in testing. Reconnect when prompted. You can remove consent in your Google account's connected-app settings; LaunchKit does not automate account revocation.

Click **Refresh Google properties and evidence**, choose a property, then click **Use selected property** and refresh again. LaunchKit offers accessible exact HTTPS-root URL-prefix properties and domain properties that cover your production hostname. It reuses existing verification. If no property appears, use the Search Console link to add/verify it or request access, then refresh. M3a does not create properties, change DNS or automate ownership verification.

Read-only/report requests do not submit sitemaps. The dashboard polls only the local saved report; provider refresh is explicit. Growth and other mutations share the existing server guard. Refreshes have network deadlines and can be repeated safely. Old launch and operations journals require no migration.

## Evidence

- Search performance: Google-reported clicks, impressions, CTR and average position for 28 inclusive Pacific-calendar days ending three days before the current Pacific date. The API request asks for final web-search data in one property aggregate. It is not a comparison or a completeness guarantee. A domain property can include other protocols/subdomains; the selected property and dates remain visible.
- No rows: **NO_DATA**, not an invented zero or proof of no indexing. Errors, denied permissions and quotas are **UNAVAILABLE**. Sitemaps and metrics report failures independently.
- Sitemaps: provider paths, processing-pending flag, last submission/download times and error/warning counts when returned. Missing fields remain unavailable. Deprecated sitemap indexed counts are not used. URL indexing inspection is **UNAVAILABLE** in M3a.
- Evidence is timestamped and marked stale after 24 hours. Interrupted refreshes cannot relabel old metrics as belonging to a new date window. Report download includes submission history. Simulation is labeled and never calls Google.

## Submit the existing sitemap

The business must have a bound production URL and a verified, approved M1 SEO step. Reconnect Google with **Authorize sitemap management** selected to request `webmasters`; owner/full-user property access is also required. This scope is broader than read-only, but obtaining it does not approve any submission.

Click **Prepare sitemap submission for approval**. Review the exact Google property and `https://your-domain/sitemap.xml`, then approve or decline. Approval is bound to that business, connection and target. LaunchKit rechecks access and the provider listing before submitting. An already-listed sitemap is recorded as observed without another PUT. Preparation, refresh, startup and scheduling never submit.

The journal distinguishes approval, durable intent, **ACCEPTED** API submission, **OBSERVED** provider listing and **UNKNOWN** outcome. Accepted/observed submissions do not prove processing or indexing. A crash after intent or an ambiguous failure cannot trigger another submission. Refresh reconciles an existing provider listing; an absent listing keeps the unresolved outcome visible. There is no force-retry or force-resubmit control in M3a. Keep the journal and inspect Search Console if reconciliation remains blocked.

Growth state lives in `grow/<business-id>.json`, separate from M1/M2. Submission history is bounded to 100 records; reaching the bound blocks new approvals for review instead of dropping unresolved intent. No production content, DNS, hosting, billing, analytics instrumentation or public posts are changed by this feature.

## Verification

`npm run check` includes deterministic Google REST/OAuth, failure, approval, interruption and API security coverage. `npm run test:browser` exercises Growth on desktop and mobile alongside M1/M2. Passing simulations do not establish real Google access.

After connecting and selecting a property, `npm run test:grow:live` provides an opt-in read-only acceptance probe. Set `LAUNCHKIT_LIVE_READ_ONLY=1` and `LAUNCHKIT_GROW_RUN_ID` to the live business ID; optionally set `LAUNCHKIT_GROW_PROPERTY` explicitly. It reads properties, sitemaps and search metrics and saves `grow-live-check.report.json` in the state directory. Missing authorization or property access is recorded as blocked. Each component must be reviewed separately; no sitemap is submitted. Public sitemap availability alone does not verify Google ownership, processing or indexing.

Official contracts: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [properties](https://developers.google.com/webmaster-tools/v1/sites/list), [sitemaps](https://developers.google.com/webmaster-tools/v1/sitemaps), [submission](https://developers.google.com/webmaster-tools/v1/sitemaps/submit), [search reporting](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).
