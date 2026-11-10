# M3c Slice 1 — read-only search and AI discoverability

Select a saved production-bound business and use **Check public content and crawl signals** in Growth. No Google/Bing connection is required. Refresh reads the exact HTTPS homepage, `/robots.txt` and `/sitemap.xml`, then renders the homepage using bounded same-host `/assets/` JavaScript and CSS. Saved reports, downloads, polling and restart do not fetch public pages or open a browser. Simulation uses synthetic initial/rendered evidence and displays **SIMULATION**. No public changes or model calls occur.

## What the findings mean

The review list puts **P1** access restrictions/unavailable evidence before **P2** content and metadata review. **P3** supporting observations, including training controls, are expandable. Each finding has its source URL, observation time, bounded evidence, why it may matter and, where review is needed, a concrete human action. Priority is a review order, not a quality or ranking score.

Homepage crawler policy is distinct from the existing `OBSERVED / REVIEW / UNAVAILABLE` evidence status:

| Policy | Meaning |
| --- | --- |
| ALLOWED | No supported robots rule blocks the exact homepage `/`. |
| BLOCKED | A supported selected rule disallows `/`. Training restrictions are observations, not search defects. |
| INDETERMINATE | Retrieved text needs manual interpretation because syntax or matching is outside the evaluator's supported subset. |
| UNAVAILABLE | No usable robots response: DNS/read failure, non-200 response, or wrong content type. No permission inferred, including on 404. |

This is a static policy interpretation, not a request as any named bot. Actual crawler access can differ because of caching, WAFs, provider behavior or other response directives. ALLOWED never establishes retrieval, indexing, model training, answer inclusion or citations. Policies for paths other than `/` are unmeasured.

**Initial HTML evidence** retains canonical, response directives, title/description and source text counts. Source text may include noscript fallback instructions; it is never substituted for rendered product evidence.

**JavaScript-rendered evidence** separately records browser title, description, visible H1–H3 headings and a bounded text excerpt. Product assessments look for a single visible H1 and small English purpose, audience and limitation patterns. Purpose can use the rendered meta description, with that provenance explicitly labeled. Runtime instructions such as “enable JavaScript” are excluded from product-purpose/limitation candidates. **All four assessments remain REVIEW**, even with a candidate excerpt. A matching phrase does not prove factual accuracy, quality, completeness or AI comprehension; a missing phrase does not establish absent content.

Browser absence, timeout, script errors, failed/unsupported first-party assets or secondary navigation produce **UNAVAILABLE**, with no static-content fallback assessment. Initial HTML, robots and sitemap evidence remains available independently. Candidate excerpts are redacted and bounded; raw pages, scripts, full DOMs and text archives are not saved.

## Restricted rendering

The existing Playwright dependency launches installed Chrome in a fresh, sandboxed, nonpersistent context. Browser networking is offline. An ephemeral loopback socket rejects all proxy connections; browser DNS resolution and non-proxied WebRTC are also disabled. The browser receives the already-read homepage and allowed assets through request fulfillment; it never uses `route.continue` or browser-side network fetching. Service workers and WebSockets are blocked. Additional CSP restrictions retain the original CSP and disallow connections, frames, workers, forms and external resources. No credentials, cookies, browser request headers or Set-Cookie responses are forwarded. No clicks, links, uploads or forms are exercised.

Only GET scripts/styles at exact-origin HTTPS `/assets/` paths ending in `.js`, `.mjs` or `.css` can reach the existing validated, pinned-IP HTTPS transport. Query strings, credentials, other ports/hosts, redirects, API/XHR/fetch calls and other paths/resource types are rejected. Asset reads are serialized with at most 16 resources, 4,000,000 bytes per asset and an 8,000,000-byte aggregate body budget. Each has a six-second deadline and the browser observation has a twelve-second deadline after a maximum ten-second launch. Pending reads are aborted on completion/failure. After load, a 1.5-second observation window captures at most 12,000 text characters, 20 headings and 20,000 text nodes per extraction. Only short excerpts become journal findings.

This narrowly supports self-contained Vite-style applications and static pages, without adding a new browser service or general crawler. Applications requiring API data, third-party scripts, other asset layouts, workers, fonts or images may be incomplete or unavailable. Offline detection, the desktop viewport and the short observation window can affect behavior. Visibility filtering checks layout rectangles, hidden/aria-hidden ancestors, CSS display/visibility/opacity and content-visibility; it does not prove lack of occlusion or evaluate every responsive, interactive, shadow-DOM or delayed state. Other languages and unconventional phrasing require manual review.

Reviewed official Playwright documentation on 2026-10-29: [network interception](https://playwright.dev/docs/network), [isolated contexts and service-worker limitations](https://playwright.dev/docs/api/class-browsercontext#browser-context-route), and [WebSocket routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket). Playwright itself is not the SSRF boundary: outbound page/asset bytes are supplied by LaunchKit's constrained Node HTTPS transport.

## Robots subset and research

Official sources reviewed **2026-10-29**:

| Identity | Purpose used in this audit | Official source |
| --- | --- | --- |
| Googlebot | Google search crawling | [Google common crawlers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers) |
| bingbot | Bing search crawling | [Bing crawler identities](https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0) |
| OAI-SearchBot | ChatGPT search | [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots) |
| GPTBot | Potential model-training collection, separate from search | [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots) |
| Claude-SearchBot | Search discovery | [Anthropic crawler documentation](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler) |
| ClaudeBot | Potential model-training collection, separate from search | [Anthropic crawler documentation](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler) |
| PerplexityBot | Search discovery; not foundation-model training | [Perplexity crawler documentation](https://docs.perplexity.ai/docs/resources/perplexity-crawlers) |

User-triggered fetchers such as ChatGPT-User, Claude-User and Perplexity-User are outside this automatic search-crawler audit. They have distinct provider-specific behavior. This is a deliberately small identity list, not every provider control or crawler.

The evaluator follows the supported subset of [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html), [Google's robots interpretation](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec), and [Bing's specific-group convention](https://www.bing.com/webmasters/help/how-to-create-a-robots-txt-file-cb7c31ec): case-insensitive exact product-token groups override wildcard groups; matching groups merge; adjacent user-agent lines share rules; empty rules impose no restriction; longest matching paths win with Allow on equal specificity. ASCII path prefixes, `*` and terminal `$` are evaluated only against `/`. Blank lines and non-REP fields such as Sitemap do not split groups. Crawl-delay is not evaluated as access policy.

An exact product-token match is selected before examining shorter partial names: a `bot` or `google` group cannot make an exact `Googlebot` group ambiguous. Without an exact group, partial product-token matching remains INDETERMINATE because provider-specific behavior is outside this subset. Malformed lines, unsupported user-agent syntax, selected percent-encoded/non-ASCII paths, invalid path syntax, paths over 500 characters, invalid text and files over 4,000 lines also produce INDETERMINATE. Unsupported path rules in unrelated groups do not affect the selected group. Conservative uncertainty is intentional; this is not a full replacement for providers' parsers.

## Storage and boundaries

The latest bounded findings reuse `grow-audit/<business-id>.json`, schema 1, with an optional inspection-version marker. Old technical reports remain readable without migration. Old static product assessments are suppressed on read, marked stale and replaced with rendered UNAVAILABLE until the owner explicitly refreshes. Launch, Google, Bing, social and monitoring journals remain independent. The existing authenticated same-origin API and shared mutation guard are unchanged.

The three initial endpoint requests retain public DNS validation/pinning, exact production hostname, valid TLS, fixed paths, no redirects/cookies/credentials, 10-second DNS and 15-second HTTPS deadlines, and a 512,000-byte response bound. Render asset limits are described above. Endpoint failures remain independent. [Slice 2](grow-improvements.md) adds a separate exact-approved title improvement and read-only before/after verification. Audit refresh itself never publishes. AI visibility sampling and a combined growth dashboard are not provided. Existing Mastodon functionality and history are preserved.

Deterministic unit/API/browser fixtures test behavior, not real provider acceptance. Independently observed public audits must be dated and labeled separately from fixtures and authenticated Google/Bing measurements.
