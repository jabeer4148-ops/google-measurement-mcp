# Design notes

Why this server is shaped the way it is. If you are evaluating whether to point an agent at it, this is the document that matters.

---

## The problem this is built around

Reading analytics with an AI agent is low-risk. The worst outcome is a wrong number in a conversation.

Writing to Google Tag Manager is not. A bad container publish changes tracking on every page of a live site, and it fails **silently** — no error, no alert, just a gap in a chart that someone notices a week later. By then the cause is buried.

Every design decision below follows from treating that asymmetry as the central constraint rather than an edge case.

---

## 1. Write tools are absent, not disabled

Without `--enable-write` (or `GMCP_ENABLE_WRITE=1`), the nine write tools are **never constructed and never registered**. They do not appear in `tools/list`.

This matters more than a permission check. An agent that can see a tool will eventually try it, and will treat an error as an obstacle to route around — retrying with different arguments, or explaining to the user how to enable it. A tool that does not exist produces no such pressure.

The registry is built conditionally rather than built-and-filtered, so a future refactor that reorders the filtering cannot leak write tools into read mode. In read mode they are never instantiated at all.

Three assertions at startup, each throwing rather than shipping a silent defect:

- a tool name registered twice
- a `write: true` tool in the read registry
- a tool in the write registry not marked `write: true`

## 2. Destructive operations do not exist

Not implemented, in either mode:

`delete_key_event` · `archive_custom_dimension` · `delete_sitemap` · tag / trigger / variable deletion · GSC site add & remove · GA4 property and data-stream mutation

**Defence is two-layer.** The tools are absent, *and* the corresponding OAuth scopes are never requested. `tagmanager.delete.containers`, `tagmanager.manage.users`, `tagmanager.manage.accounts`, `analytics.manage.users`, `analytics.provision` and `analytics.user.deletion` are deliberately excluded from the scope list.

So even a write-mode token that leaked entirely could not delete a GTM container. The capability is not gated — it was never granted.

## 3. Publishing requires explicit confirmation

`gtm_publish_version` is the only operation here that changes a live website. It requires `confirm: true`.

Called without it, the tool performs a **dry run**: fetches the candidate version, fetches what is currently live, diffs them, and returns a summary instructing the caller to get human approval. It makes no publish call.

**The diff is by name, not by count.** "3 tags → 3 tags" reads as a no-op while concealing a swap. "added `Checkout Tracking`, removed `Legacy Purchase`" is the information a human needs in order to approve or refuse. Counting would have made the most dangerous change look like the safest one.

**The absent-live-version case is flagged explicitly.** A container with nothing live yet produces an empty diff under naive comparison, when it is in fact the highest-risk publish — everything becomes live at once. That case returns a specific note instead.

### 3.1 Why `confirm !== true` rather than a truthiness check

An agent emitting `confirm: "true"` as a string is a realistic failure mode; language models stringify booleans constantly. `1`, `"yes"`, and `{}` are all truthy.

The schema declares `confirm` as `boolean` and validation rejects anything else before the handler runs, and the handler tests `input.confirm !== true`. A truthiness check would have published on every one of those inputs.

This is asserted by a spy test that fails if the publish API is called under any of them.

## 4. `gtm_update_tag` merges rather than replaces

This is the one place the server deliberately does **not** mirror Google's behaviour.

The raw GTM update endpoint is a full replacement. Omitting `firingTriggerId` clears it — leaving a tag that appears entirely normal in the GTM UI, still lists correctly via the API, and **never fires**. There is no error and nothing visually wrong. An agent updating a tag's name would silently disconnect it from its triggers.

This server reads the current tag and merges the supplied fields over it:

- **Omission preserves.** Fields you don't send are carried over from the current tag.
- **An explicit empty array clears.** `firingTriggerId: []` deliberately unwires the tag.
- **`parameter` merges by key**, so one parameter can change without wiping the rest.

Deliberate destruction stays reachable; accidental destruction does not. The response reports `preservedFields` so the caller can see what was carried over.

Cost: one extra `tags.get` per update. Updates are not loop-shaped, so the GTM quota impact is negligible.

## 5. The recurring pattern

The same shape appears three times, and it is the intended mental model for the whole server:

| Dangerous capability | Safe default | Explicit opt-in |
|---|---|---|
| Any write at all | Tools not registered | `--enable-write` |
| Publishing to a live site | Dry run with a diff | `confirm: true` |
| Clearing a tag field | Omission preserves | Explicit `[]` |

Safe by default, dangerous only on purpose. Where the two conflict, the safe reading wins and the dangerous one requires saying so.

---

## 6. Supporting decisions

**Row caps.** Every list and report tool caps at 25 rows by default. GA4 and Search Console will happily return tens of thousands and destroy an agent's context window. When output is clipped the response carries `truncated: true` and guidance to narrow the query rather than raise the limit. When the upstream API reports no total, the response says the total is unknown rather than implying the over-fetch count is the real total.

**Typed errors, never stack traces.** Six error classes — `AuthError`, `PermissionError`, `QuotaError`, `NotFoundError`, `ValidationError`, `UpstreamError`. Google signals permission denial and quota exhaustion with the *same* 403 and distinguishes them only by reason code, so 403 is routed on reason rather than status. Getting that backwards sends someone hunting for a permissions problem that does not exist.

**Local stdio only.** No hosted or HTTP transport. Your Google credentials stay on your machine. A remote server would mean storing refresh tokens on someone else's infrastructure.

**Schema is the single source of truth.** Tool registration references the schema object; validation is driven from that same object. Hand-written checks drift from declared schemas, and a drifted validator is worse than none because it looks enforced.

**Validation happens before any network call.** Malformed input raises `ValidationError` locally. Asserted with a spy proving zero API calls were attempted — not merely that an error was raised, since an error can be thrown after a request has already gone out.
