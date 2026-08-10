# google-measurement-mcp

**The Google measurement stack for AI agents — GA4, Search Console, and Tag Manager in one MCP server.**

Read tools are always on. Write tools are off unless you explicitly enable them. Destructive operations are not implemented at all.

> **Status: Phase 1 (early).** One tool ships today (`ga4_run_report`). The full read suite lands next. See [Roadmap](#roadmap).

---

## Why this exists

Pointing an AI agent at your analytics is low-risk. Pointing one at your **live Tag Manager container** is not — a bad publish breaks tracking on every page of your site.

Most GTM MCP servers can publish containers. This one makes that hard on purpose:

- **Write tools are absent unless you pass `--enable-write`.** Not present-and-erroring — genuinely not in the tool list, so an agent cannot see or attempt them.
- **Destructive operations do not exist in the codebase.** No delete, no archive, no removal of tags, triggers, variables, sitemaps, or key events. This is a deliberate design choice, not a gap.
- **Publishing requires human confirmation.** `gtm_publish_version` without `confirm: true` returns a diff of what *would* go live and refuses to publish.

If you want a read-only GA4 server and nothing else, **use [Google's official one](https://github.com/googleanalytics/google-analytics-mcp)** — it's excellent, it's maintained by Google, and it's the better choice for that job. This server exists for people who need Search Console and Tag Manager in the same place, and who want write access without handing an agent a loaded gun.

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

| Tool | Does | Access | Reversible |
|---|---|---|---|
| `ga4_run_report` | Runs a GA4 report, returns flat rows | Read | n/a |

Responses are capped at 25 rows by default. When output is clipped you get `truncated: true` plus guidance — prefer narrowing the query over raising `limit`.

---

## Safety

**Not implemented, by design:**

`delete_key_event` · `archive_custom_dimension` · `delete_sitemap` · tag / trigger / variable deletion · GSC site add & remove · GA4 property and data-stream mutation

These are omitted deliberately. An agent cannot call what does not exist.

**Also:**

- GTM writes operate on a **workspace**, never directly on the live container.
- `gtm_publish_version` requires `confirm: true`; without it you get a diff and nothing publishes.
- GTM keeps version history, so a publish can be rolled back from the GTM UI.

---

## Troubleshooting

**"The app name does not comply with Google's requirements"**
Your OAuth app name contains "Google", which Google's branding policy prohibits. Rename it to `Measurement MCP`. This is a consent-screen display label only and is unrelated to the package name.

**"Your saved Google login is no longer valid"**
Most likely your consent screen is still in **Testing** (7-day token expiry) — see [step 4](#4-️-set-your-consent-screen-to-in-production). Other causes: more than 25 saved logins for one OAuth client, a clock out of sync, or access revoked from your Google account page.

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
- [ ] **Phase 2** — full read suite across GA4, Search Console, Tag Manager
- [ ] **Phase 3** — write tools behind the flag, publish confirm gate
- [ ] **Phase 4** — contract tests, live smoke suite, traceability
- [ ] **Phase 5** — npm release

---

## Requirements

Node.js >= 20.

## License

Apache-2.0
