# M3c — approved social publishing

M3c supports text posts to the customer's own **mastodon.social** account. Drafts, website announcement templates, exact approvals and publication history work without a model or paid service. Other Mastodon servers, media, replies, direct messages, scheduled/bulk posting, AI generation and campaign analytics are outside this slice. A combined campaign dashboard is not provided.

## Connect and publish

1. Sign in to your mastodon.social account. Open **Preferences → Development → New application** ([direct link](https://mastodon.social/settings/applications)). Name it LaunchKit and select only `read:accounts`, `read:statuses` and `write:statuses`. Save and copy **Your access token**, not the client secret or an application-only token. Account signup and verification remain customer actions.
2. In LaunchKit, select a bound business. Expand **Social publishing → Connect mastodon.social**, save the token, then select **Verify publishing account**. The token grants access to the account, not just one business. Windows protects it using the existing DPAPI vault; other systems retain it in memory or accept `MASTODON_ACCESS_TOKEN` from a user-managed environment. Empty fields preserve the saved connection. Tokens never reappear in forms, journals or reports. Revoke the application in Mastodon to remove provider access.
3. Write and save a draft, or create a website announcement from the saved title, description and production URL. Review those claims yourself. You can edit saved, unattempted drafts. There is no AI call or model credential requirement.
4. Choose **Unlisted** (default) or **Public**. Both are publicly accessible; unlisted avoids public timelines. Prepare the saved post for approval. Review the exact text, visibility, account, business and content hash. Then approve and publish, or decline. Verify that you selected the intended business and publishing account.
5. Inspect the result in history. **Reconcile publication (read only)** checks the returned provider post ID and original source. If a response was lost, inspect your Mastodon profile and enter the numeric ID from the post URL. No publication is sent by this action.

Character limits are read from the instance before approval and again before sending. Counting is conservative for URLs, so LaunchKit may ask you to shorten a post that Mastodon would otherwise accept. Drafts must not contain credentials or secret-like text, because local reports redact those values and could not show an exact approval preview. Each business retains up to 200 drafts, with up to 200 approval records per draft; there is no automatic removal of publication evidence.

## Durable approval and uncertain outcomes

The local journal records approval history, destination/content hash, connection identity, business settings revision, send intent, provider ID and observation timestamps separately. Saving edits invalidates pending approval. Changing the connection or business settings requires fresh approval. The account is verified again immediately before sending. Clicking an old approval cannot send again. Attempted drafts are immutable, and identical content with a previous attempt at the same destination is blocked within the business history.

- **DRAFT / AWAITING APPROVAL / DECLINED:** no publication attempted.
- **INTENT / UNKNOWN:** the durable intent exists, but the outcome is uncertain. Interrupted intents display as UNKNOWN after restart. There is no automatic or manual resend for that draft.
- **ACCEPTED:** a valid provider response supplied the post ID. This does not prove audience delivery.
- **OBSERVED:** a read found matching source text, visibility, account and an appropriate creation timestamp. The timestamp is historical evidence, not continuous monitoring. If a later reconciliation cannot verify the post, its status becomes UNKNOWN while retaining the earlier receipt and observation timestamp. Missing, edited or deleted posts do not authorize resending.

Every send uses the approval UUID as Mastodon's idempotency key. The provider retains keys for only up to one hour; LaunchKit never relies on a late retry. All send failures conservatively remain UNKNOWN, including rejections, so correcting a connection does not silently send an old attempt. Reconciliation with an unknown provider ID requires customer inspection; it never searches timelines and guesses by similar text. A matching post proves existence, not causality, distribution or campaign effectiveness. Reconnect the original account to reconcile after account changes. Token rotation for that same account can reconcile existing history.

GET reports, startup, selection, template creation and account verification never publish. Simulation uses an isolated in-memory provider and makes no Mastodon requests; saved history persists, while simulated remote evidence is unavailable after restarting the process. Launch, DNS, monitoring and existing Google/Bing journals are unchanged by social operations.

## Provider boundaries

The connector supports one customer-owned mastodon.social account and individually approved text posts. It does not schedule posts, automate engagement, or bypass provider account requirements. Account access and provider limits can change; consult the [authorization guide](https://docs.joinmastodon.org/client/authorized/), [status API](https://docs.joinmastodon.org/methods/statuses/), and [community standards](https://help.joinmastodon.org/article/12-community-standards) when configuring access.

Provider permission errors are sanitized. An account read does not prove write scope or successful posting. No authenticated live publishing is established by the automated simulation/contract tests.

## Verification

`npm run check` exercises typed contracts, approval invalidation, durable intent, response loss, reconciliation, isolation and API security. `npm run test:browser` exercises the editor, exact approval, publication history, reload and mobile layout with simulation.

`npm run test:social:live` skips by default. With `LAUNCHKIT_LIVE_READ_ONLY=1` and a saved token or `MASTODON_ACCESS_TOKEN`, it verifies the account and instance character limits. Optionally set `LAUNCHKIT_MASTODON_POST_ID` to inspect the original source of one existing post on your own account; the report stores a source hash, not the post text. It never publishes, deletes, creates an app or creates an account. Without customer authorization, authenticated integration remains **NOT VERIFIED**. A live publication requires separate approval of the exact post in the UI.
