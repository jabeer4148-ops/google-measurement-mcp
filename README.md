# google-measurement-mcp

**The Google measurement stack for AI agents — GA4, Search Console, and Tag Manager in one MCP server.**

Read tools are always on. Write tools are off unless you explicitly enable them. Destructive operations are not implemented at all.

> **Status: Early — v0.1.0.** 15 read tools and 9 opt-in write tools are available across GA4, Search Console, and Tag Manager. See [Roadmap](#roadmap).

---

## Why this exists

Pointing an AI agent at your analytics is low-risk. Pointing one at your **live Tag Manager container** is not — a bad publish breaks tracking on every page of your site.

Most GTM MCP servers can publish containers. This one makes that hard on purpose:

- **Write tools are absent unless you pass `--enable-write`.** Not present-and-erroring — genuinely not in the tool list, so an agent cannot see or attempt them.
- **Destructive operations do not exist in the codebase.** No delete, no archive, no removal of tags, triggers, variables, sitemaps, or key events. This is a deliberate design choice, not a gap.
- **Publishing requires human confirmation.** `gtm_publish_version` without `confirm: true` returns a diff of what *would* go live and refuses to publish.

## Should you use this or Google's official server?

**If you only need GA4, and only reads — use [Google's](https://github.com/googleanalytics/google-analytics-mcp).** It's maintained by Google, it has a far larger community, and it has GA4 features this server does not.

| | google-measurement-mcp | [Google's analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) |
|---|---|---|
| **APIs** | GA4 + Search Console + Tag Manager | GA4 only |
| **Writes** | Yes, behind an explicit flag | No — read-only |
| **Funnel reports** | ❌ not implemented | ✅ `run_funnel_report` |
| **Google Ads links** | ❌ not implemented | ✅ `list_google_ads_links` |
| **Property details** | Partial (via account summaries) | ✅ `get_property_details` |
| **Runtime** | Node ≥ 20, npm | Python 3.10+, PyPI |
| **Auth** | OAuth, service account, or ADC | ADC |
| **Maintainer** | Community (one person) | Google |
| **Status** | Early — v0.1.0 | Experimental |
| **License** | Apache-2.0 | Apache-2.0 |

**Where Google's is genuinely better:** GA4-only workflows, funnel analysis, Google Ads attribution, and the simple fact that it's maintained by the team that owns the API. If your question is "what happened in my GA4 property," reach for theirs first.

**Where this one earns its place:** you need Search Console and Tag Manager alongside GA4 without running three servers, or you need write access and want the dangerous operations to be hard to reach by accident. Running both side by side is entirely reasonable — they don't conflict.

---

## Quickstart (about 5 minutes)

### 1. Create a Google Cloud project and enable the APIs

In the [Google Cloud console](https://console.cloud.google.com/), create a project, then enable:

- Google Analytics Data API
- Google Analytics Admin API
- Google Search Console API
- Tag Manager API

### 2. Configure the consent screen

**APIs & Services → OAuth consent screen.** Google has migrated this to **Google Auth Platform**, where the settings are split across left-nav pages — *Branding*, *Audience*, *Clients*, *Data Access*. Set user type **External** and your email as both contacts.

> **Do not name the app `google-measurement-mcp`.** Google rejects any OAuth app name containing "Google" with a message that doesn't explain why:
> *"The request failed because the app name does not comply with Google's requirements."*
>
> Name it **`Measurement MCP`** instead. It's only the label on your own consent screen and has nothing to do with the package name.

### 3. ⚠️ Publish the app — do not skip this

**Google Auth Platform → Audience → Publish app.** (Older UI: OAuth consent screen → Publishing status.)

> If you leave the status as **Testing**, Google expires your login after **7 days** and you will have to sign in again every week.
>
> Publishing is *not* Google verification. You are the only user of your own OAuth client, so there is no review, no security audit, and no waiting. You will see a one-time "Google hasn't verified this app" screen — that is expected. Click **Advanced → Go to (unsafe)**. It is your own app.

### 4. Create an OAuth client

**Google Auth Platform → Clients → Create OAuth client → Application type: Desktop app.** (Older UI: APIs & Services → Credentials → Create credentials → OAuth client ID.)

Note the client ID and secret. **Desktop app** matters — a "Web application" client fails with `redirect_uri_mismatch`.

### 5. Configure your MCP client

<details open>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add google-measurement \
  --scope user \
  -e GMCP_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com \
  -e GMCP_OAUTH_CLIENT_SECRET=your-client-secret \
  -- npx -y google-measurement-mcp
```

Add `--enable-write` after the package name to expose write tools.

</details>

<details>
<summary><strong>Cursor</strong> — <code>~/.cursor/mcp.json</code></summary>

```json
{
  "mcpServers": {
    "google-measurement": {
      "command": "npx",
      "args": ["-y", "google-measurement-mcp"],
      "env": {
        "GMCP_OAUTH_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GMCP_OAUTH_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

Reload MCP servers after editing, or the old tool list stays cached.

</details>

<details>
<summary><strong>Claude Desktop</strong> — <code>claude_desktop_config.json</code></summary>

Same shape as Cursor. macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. Windows: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "google-measurement": {
      "command": "npx",
      "args": ["-y", "google-measurement-mcp"],
      "env": {
        "GMCP_OAUTH_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GMCP_OAUTH_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>claude.ai custom connectors</strong></summary>

Not currently supported. claude.ai connectors require a **remote** MCP server over HTTP; this is a local stdio server by design, which keeps your Google credentials on your own machine rather than on someone else's.

</details>

### 6. Sign in once

Run the server once in a terminal. It prints a URL — open it, approve, done. The refresh token is cached at `~/.config/google-measurement-mcp/` with owner-only permissions, and your MCP client picks it up from then on.

```bash
GMCP_OAUTH_CLIENT_ID=... GMCP_OAUTH_CLIENT_SECRET=... npx -y google-measurement-mcp
```

**No permission grants needed in GA4, Search Console, or Tag Manager.** OAuth uses the access your Google account already has.

---

## Enabling write tools

Write tools are hidden by default. To expose them:

```json
{
  "mcpServers": {
    "google-measurement": {
      "command": "npx",
      "args": ["-y", "google-measurement-mcp", "--enable-write"],
      "env": { "GMCP_ENABLE_WRITE": "1" }
    }
  }
}
```

Either the flag or the env var is sufficient. On startup the server writes a line to stderr naming every write tool it exposed.

Write mode requests additional OAuth scopes, so **you must sign in again** after enabling it.

---

## Alternative setup: service account (agencies and CI)

Use this when you need headless operation, scheduled jobs, or one identity across many client properties. It is more work — it requires granting access in three separate product UIs.

<details>
<summary><strong>Service account setup (8 steps)</strong></summary>

1. Create a service account in your Google Cloud project.
2. Create and download a JSON key.
3. **GA4** → Admin → Property Access Management → add the service account email as **Viewer** (read) or **Editor** (write).
4. **Search Console** → Settings → Users and permissions → add the email as **Full** or **Owner**.
5. **Tag Manager** → Admin → User Management → add the email with **Publish** permission on the container.
6. Set `GOOGLE_APPLICATION_CREDENTIALS` to the JSON key path.

```json
{
  "mcpServers": {
    "google-measurement": {
      "command": "npx",
      "args": ["-y", "google-measurement-mcp"],
      "env": { "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/key.json" }
    }
  }
}
```

**Note:** many organizations block service account key creation via the `constraints/iam.disableServiceAccountKeyCreation` org policy. If key creation fails, use OAuth instead.

</details>

<details>
<summary><strong>Third option: gcloud ADC</strong></summary>

If you already have the gcloud CLI:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/analytics.readonly,\
https://www.googleapis.com/auth/webmasters.readonly,\
https://www.googleapis.com/auth/tagmanager.readonly
```

No further configuration is needed — the server picks up ADC automatically.

**Untested for write scopes.** Google restricts which scopes gcloud's built-in client may request. If write mode fails under ADC, use OAuth or a service account.

</details>

---

## Credential resolution order

1. `GOOGLE_APPLICATION_CREDENTIALS` — service account, if set
2. Cached user OAuth token
3. Application Default Credentials

The startup line on stderr tells you which one resolved.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GMCP_OAUTH_CLIENT_ID` | — | OAuth desktop client ID |
| `GMCP_OAUTH_CLIENT_SECRET` | — | OAuth desktop client secret |
| `GMCP_OAUTH_CLIENT_JSON` | — | Path to a downloaded OAuth client JSON, instead of the two above |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Service-account JSON key path |
| `GMCP_ENABLE_WRITE` | unset | `1` enables write tools (same as `--enable-write`) |
| `GMCP_DEFAULT_ROW_LIMIT` | `25` | Default row cap on every report tool |
| `GMCP_TOKEN_PROFILE` | `default` | Named profile, for holding several Google identities on one machine |

---

## Tools

### Read — always available (15)

| Tool | Does |
|---|---|
| `ga4_list_account_summaries` | Accounts and properties. **Start here** to find a propertyId |
| `ga4_run_report` | GA4 report, returned as flat rows |
| `ga4_run_realtime_report` | Last ~30 minutes |
| `ga4_list_custom_dimensions` | Custom dimensions with scope |
| `ga4_list_key_events` | Key events with counting method |
| `gsc_list_sites` | Search Console properties. **Start here** for a siteUrl |
| `gsc_search_analytics_query` | Clicks, impressions, CTR, position |
| `gsc_list_sitemaps` | Submitted sitemaps with warnings and errors |
| `gsc_inspect_url` | Index status for one URL (quota: 2,000/day per property) |
| `gtm_list_accounts` | GTM accounts. **Start here** for an accountId |
| `gtm_list_containers` | Containers — note `containerId` (numeric) vs `publicId` (GTM-XXXXXXX) |
| `gtm_list_workspaces` | Workspaces in a container |
| `gtm_list_tags` | Tags with type, triggers and parameters |
| `gtm_list_triggers` | Triggers with firing conditions |
| `gtm_list_variables` | User-defined variables |

Responses are capped at 25 rows by default. When output is clipped you get `truncated: true` plus guidance — prefer narrowing the query over raising `limit`.

### Write — only with `--enable-write` (9)

| Tool | Does | Reversible |
|---|---|---|
| `ga4_create_custom_dimension` | Creates a custom dimension | **No** — archive-only, and slots are limited |
| `ga4_create_key_event` | Marks an event as a key event | Yes, from the GA4 UI |
| `ga4_update_key_event` | Changes counting method | Yes |
| `gsc_submit_sitemap` | Submits a sitemap URL | Yes, from the Search Console UI |
| `gtm_create_tag` | Creates a tag in a workspace | Yes — not live until published |
| `gtm_update_tag` | Updates a tag, **merging** over its current config | Yes — not live until published |
| `gtm_create_trigger` | Creates a trigger in a workspace | Yes — not live until published |
| `gtm_create_version` | Snapshots a workspace into a version | Safe — creating ≠ publishing |
| `gtm_publish_version` | **Publishes to the live site** | Yes, via GTM version history |

**`gtm_update_tag` merges — omission preserves, explicit empty clears.**

The raw GTM API *replaces*: omitting `firingTriggerId` silently empties it, leaving a tag that looks completely normal in the GTM UI and never fires. We verified that against the live API, then made this server read-then-merge so it cannot happen by accident.

```jsonc
// changes the name, keeps everything else
{ "tagPath": "...", "name": "New name", "type": "html" }

// deliberately unwires the tag from all triggers
{ "tagPath": "...", "name": "New name", "type": "html", "firingTriggerId": [] }
```

`parameter` merges by key, so you can change one parameter without resending the rest. The response lists `preservedFields` so you can see what was carried over.

---

## Safety

**Not implemented, by design:**

`delete_key_event` · `archive_custom_dimension` · `delete_sitemap` · tag / trigger / variable deletion · GSC site add & remove · GA4 property and data-stream mutation

These are omitted deliberately. An agent cannot call what does not exist.

**Also:**

- GTM writes operate on a **workspace**, never directly on the live container.
- GTM keeps version history, so a publish can be rolled back from the GTM UI.

### The publish confirm gate

`gtm_publish_version` is the only operation here that changes a live website. It requires `confirm: true`.

Called without it, the tool performs a **dry run**: it fetches the version that would go live, diffs it against the currently live version, and returns a summary — naming tags, triggers and variables added or removed. It publishes nothing.

```jsonc
// confirm omitted -> nothing published
{
  "published": false,
  "dryRun": true,
  "wouldPublish": { "containerVersionId": "7", "tagCount": 3 },
  "currentlyLive": { "containerVersionId": "6", "tagCount": 3 },
  "delta": { "tags": { "added": ["Tag NEW"], "removed": ["Tag GONE"], "unchangedCount": 2 } },
  "instruction": "NOTHING WAS PUBLISHED. Show this summary to a human..."
}
```

This is verified by a spy test asserting the publish API is never invoked without `confirm: true` — including when `confirm` is a truthy non-boolean like `"true"` or `1`, which validation rejects:

```bash
node scripts/verify-confirm-gate.mjs
```

---

## Troubleshooting

**"The app name does not comply with Google's requirements"**
Your OAuth app name contains "Google", which Google's branding policy prohibits. Rename it to `Measurement MCP`. This is a consent-screen display label only and is unrelated to the package name.

**"Your saved Google login is no longer valid"**
Most likely your consent screen is still in **Testing** (7-day token expiry) — see [step 3](#3-️-publish-the-app--do-not-skip-this). Other causes: more than 25 saved logins for one OAuth client, a clock out of sync, or access revoked from your Google account page.

**`redirect_uri_mismatch`**
Your OAuth client is a "Web application" type. Create a **Desktop app** client instead.

**"Permission denied"**
The signed-in identity lacks access to that property, site, or container — or the relevant API is not enabled in your Cloud project. On the service-account path, confirm all three grants were made.

**One API works but another returns nothing (e.g. GA4 fine, Tag Manager empty)**
Your GA4, Search Console and Tag Manager assets are probably split across different Google accounts. `gtm_list_accounts` returning **0 rather than an error** is the tell — the call succeeded, there was simply nothing that identity could see.

**Do not re-authenticate as the other account.** That usually just moves the problem, forfeiting access to whichever APIs currently work. Instead grant your existing identity access to the missing asset:

- **Tag Manager** → Admin → User Management → add your email
- **GA4** → Admin → Property access management → add your email
- **Search Console** → Settings → Users and permissions → add your email

No re-authentication needed; the scopes are already granted. Permission changes take a minute or two to propagate.

**"Google quota exhausted"**
Search Console URL Inspection is capped at 2,000/day and 600/minute per property. The Tag Manager API has strict per-user limits — space GTM calls out by minutes, not seconds.

**Write tools are missing**
Expected unless you passed `--enable-write` or set `GMCP_ENABLE_WRITE=1`. Re-authenticate after enabling, since write mode needs extra scopes.

---

## Roadmap

- [x] **Phase 1** — auth, server, `ga4_run_report`
- [x] **Phase 2** — full read suite across GA4, Search Console, Tag Manager
- [x] **Phase 3** — write tools behind the flag, publish confirm gate
- [x] **Phase 4** — contract tests, traceability matrix, CI
- [ ] **Phase 5** — npm release

---

## Development

```bash
npm install
npm run build
npm test                              # 73 contract tests, no network, no credentials
node scripts/verify-confirm-gate.mjs  # 17 assertions on the publish gate
```

Contract tests stub the Google clients and assert on call behaviour, so they run anywhere including CI. The safety-critical ones live in `test/contract/safety.test.ts` — a failure there is a release blocker.

Three documents cover the engineering detail:

- [`docs/DESIGN.md`](docs/DESIGN.md) — why the safety architecture is shaped the way it is
- [`docs/API-NOTES.md`](docs/API-NOTES.md) — Google API behaviours that are undocumented, easy to miss, or actively misleading
- [`docs/TESTING.md`](docs/TESTING.md) — traceability matrix mapping every tool to its API method, scope, reversibility, quota and covering tests, plus the known gaps

## Requirements

Node.js >= 20.

## License

Apache-2.0
