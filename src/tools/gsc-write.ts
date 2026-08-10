/**
 * Search Console write tools (searchconsole v1).
 *
 * Registered only when write mode is enabled (handover D4).
 *
 * NOT implemented, by design (handover D5): sitemap deletion, and site add /
 * remove. Search Console has no write surface that touches rankings or content,
 * so the blast radius here is the smallest of the three APIs — but deletion is
 * still omitted for consistency with the rest of the server.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { ValidationError, mapGoogleError } from "../errors.js";
import { normalizeSiteUrl } from "../lib/normalize.js";
import { validateInput } from "../lib/validate.js";
import { gscSubmitSitemapSchema } from "../schemas/phase3.js";
import type { ToolDefinition } from "../schemas/index.js";

export function createGscWriteTools(
  getClient: () => Promise<OAuth2Client>,
  _config: Config,
): ToolDefinition[] {
  return [
    {
      name: "gsc_submit_sitemap",
      title: "Submit a sitemap to Search Console",
      description:
        "CHANGES CONFIGURATION. Submits a sitemap URL to Search Console for a property. " +
        "REVERSIBLE, but not by this server: a submitted sitemap can be removed from the Search Console UI; " +
        "deletion is deliberately not implemented here. " +
        "Submitting does not force indexing and does not affect rankings — it tells Google where to find your URL list. " +
        "Re-submitting an already-submitted sitemap is harmless and simply refreshes it.",
      inputSchema: gscSubmitSitemapSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{ siteUrl: string; feedpath: string }>(
          raw,
          gscSubmitSitemapSchema,
          "gsc_submit_sitemap",
        );

        const siteUrl = normalizeSiteUrl(input.siteUrl, "gsc_submit_sitemap");

        if (!/^https?:\/\//i.test(input.feedpath)) {
          throw new ValidationError(
            `gsc_submit_sitemap: feedpath must be a fully-qualified URL, got "${input.feedpath}".`,
            "Example: 'https://example.com/sitemap.xml'.",
          );
        }

        // Catch the common mistake of submitting a sitemap that belongs to a
        // different property. Google's own error for this is unhelpful.
        if (siteUrl.startsWith("http")) {
          const propertyOrigin = new URL(siteUrl).origin;
          const feedOrigin = new URL(input.feedpath).origin;
          if (propertyOrigin !== feedOrigin) {
            throw new ValidationError(
              `gsc_submit_sitemap: the sitemap origin (${feedOrigin}) does not match the property (${propertyOrigin}).`,
              "A sitemap must live within the Search Console property it is submitted to.",
            );
          }
        }

        try {
          const client = google.searchconsole({ version: "v1", auth: await getClient() });
          // Returns 204 No Content on success.
          await client.sitemaps.submit({ siteUrl, feedpath: input.feedpath });

          return {
            submitted: true,
            reversible: true,
            siteUrl,
            feedpath: input.feedpath,
            note: "Google fetches submitted sitemaps asynchronously. Call gsc_list_sitemaps after a few minutes to see lastDownloaded, warnings and errors. Removal is available from the Search Console UI.",
          };
        } catch (err) {
          throw mapGoogleError(err, "submit the sitemap to Search Console");
        }
      },
    },
  ];
}
