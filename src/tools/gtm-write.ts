/**
 * Tag Manager write tools (tagmanager v2).
 *
 * This file carries the entire blast radius of the project. Handover §8 rates
 * "agent publishes a broken GTM container" as the only High-severity risk,
 * because a bad publish breaks tracking on every page of a live site.
 *
 * Three structural protections, in order of importance:
 *
 *  1. Everything except publish operates on a WORKSPACE. A workspace is a
 *     staging area; nothing in it affects a live site until published.
 *  2. `gtm_publish_version` requires `confirm: true` (handover D6). Without it
 *     the tool performs a dry run — it fetches what would go live, diffs it
 *     against the currently live version, returns that summary, and makes NO
 *     publish call.
 *  3. Deletion is not implemented at all (handover D5). No tag, trigger,
 *     variable, version or container can be deleted through this server, and
 *     the corresponding scopes are never requested.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { ValidationError, mapGoogleError } from "../errors.js";
import { normalizeWorkspacePath } from "../lib/normalize.js";
import { validateInput } from "../lib/validate.js";
import {
  gtmCreateTagSchema,
  gtmCreateTriggerSchema,
  gtmCreateVersionSchema,
  gtmPublishVersionSchema,
  gtmUpdateTagSchema,
} from "../schemas/phase3.js";
import type { ToolDefinition } from "../schemas/index.js";

interface GtmParameter {
  type?: string;
  key?: string;
  value?: string;
}

interface VersionEntity {
  name?: string | null;
  tagId?: string | null;
  triggerId?: string | null;
  variableId?: string | null;
}

/** Compare two named collections and report what changed. */
function diffNames(
  live: VersionEntity[] | undefined,
  candidate: VersionEntity[] | undefined,
): { added: string[]; removed: string[]; unchangedCount: number } {
  const liveNames = new Set((live ?? []).map((e) => e.name ?? "").filter(Boolean));
  const candNames = new Set((candidate ?? []).map((e) => e.name ?? "").filter(Boolean));
  const added = [...candNames].filter((n) => !liveNames.has(n));
  const removed = [...liveNames].filter((n) => !candNames.has(n));
  const unchangedCount = [...candNames].filter((n) => liveNames.has(n)).length;
  return { added, removed, unchangedCount };
}

export function createGtmWriteTools(
  getClient: () => Promise<OAuth2Client>,
  _config: Config,
): ToolDefinition[] {
  const gtm = async () => google.tagmanager({ version: "v2", auth: await getClient() });

  return [
    {
      name: "gtm_create_tag",
      title: "Create a tag in a workspace",
      description:
        "CHANGES A WORKSPACE. Creates a tag in a Tag Manager workspace. " +
        "REVERSIBLE: the tag exists only in the workspace and affects no live site until a version is created " +
        "and explicitly published. Delete it from the GTM UI, or discard the workspace changes. " +
        "Consider passing paused: true when creating a tag unattended. " +
        "Requires a workspace path (or accountId + numeric containerId + workspaceId) and the GTM type code — " +
        "call gtm_list_tags on an existing container to see the codes GTM uses.",
      inputSchema: gtmCreateTagSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          path?: string;
          accountId?: string;
          containerId?: string;
          workspaceId?: string;
          name: string;
          type: string;
          parameter?: GtmParameter[];
          firingTriggerId?: string[];
          blockingTriggerId?: string[];
          paused?: boolean;
          notes?: string;
        }>(raw, gtmCreateTagSchema, "gtm_create_tag");

        const ws = normalizeWorkspacePath(input, "gtm_create_tag");

        try {
          const client = await gtm();
          const res = await client.accounts.containers.workspaces.tags.create({
            parent: ws.path,
            requestBody: {
              name: input.name,
              type: input.type,
              parameter: input.parameter as never,
              firingTriggerId: input.firingTriggerId,
              blockingTriggerId: input.blockingTriggerId,
              paused: input.paused,
              notes: input.notes,
            },
          });

          return {
            created: true,
            reversible: true,
            affectsLiveSite: false,
            note: "This tag is staged in a workspace. It will not affect any website until gtm_create_version and then gtm_publish_version with confirm: true.",
            tag: {
              path: res.data.path ?? "",
              tagId: res.data.tagId ?? "",
              name: res.data.name ?? "",
              type: res.data.type ?? "",
              paused: res.data.paused ?? false,
            },
          };
        } catch (err) {
          throw mapGoogleError(err, "create the Tag Manager tag");
        }
      },
    },

    {
      name: "gtm_update_tag",
      title: "Update a tag in a workspace",
      description:
        "CHANGES A WORKSPACE. Replaces the configuration of an existing tag. " +
        "REVERSIBLE: affects only the workspace until published, and GTM keeps version history. " +
        "CHANGES A WORKSPACE. Updates a tag, MERGING your changes over its current configuration. " +
        "REVERSIBLE: workspace-only until published, and GTM keeps version history. " +
        "Fields you omit are PRESERVED — this server fetches the current tag and merges, because the raw GTM API " +
        "replaces instead, which silently clears omitted fields. (Verified: omitting firingTriggerId on the raw API " +
        "empties it, leaving a tag that looks normal in the GTM UI but never fires.) " +
        "To deliberately CLEAR a field, pass it explicitly as an empty array — e.g. firingTriggerId: [] unwires the " +
        "tag from all triggers. Omission preserves; explicit empty clears. " +
        "`parameter` is merged by key, so you can change one parameter without resending the rest. " +
        "Requires the full tag path from gtm_list_tags.",
      inputSchema: gtmUpdateTagSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          tagPath: string;
          name: string;
          type: string;
          parameter?: GtmParameter[];
          firingTriggerId?: string[];
          blockingTriggerId?: string[];
          paused?: boolean;
          notes?: string;
        }>(raw, gtmUpdateTagSchema, "gtm_update_tag");

        if (!/^accounts\/[^/]+\/containers\/[^/]+\/workspaces\/[^/]+\/tags\/[^/]+$/.test(input.tagPath)) {
          throw new ValidationError(
            `gtm_update_tag: "${input.tagPath}" is not a tag path.`,
            "Expected 'accounts/{a}/containers/{c}/workspaces/{w}/tags/{tagId}'. Call gtm_list_tags to get it.",
          );
        }

        try {
          const client = await gtm();

          // Read-then-merge. The raw GTM update endpoint REPLACES, so omitted
          // fields are cleared — see docs/GMCP-06-phase3.md §6.3. That failure is
          // silent (a tag with no firing trigger looks normal and never fires),
          // so this server merges by default and requires an explicit empty array
          // to clear. Costs one extra GET per update; updates are not loop-shaped.
          const currentRes = await client.accounts.containers.workspaces.tags.get({
            path: input.tagPath,
          });
          const current = currentRes.data;

          // `undefined` means omitted (preserve). An explicit value — including
          // an empty array — means the caller intends that value.
          const pick = <T>(supplied: T | undefined, existing: T | undefined): T | undefined =>
            supplied !== undefined ? supplied : existing;

          // Parameters merge by key so one can be changed without resending all.
          const mergedParameter = (() => {
            if (input.parameter === undefined) return current.parameter ?? undefined;
            // googleapis types allow null on every field; the local shape does
            // not. Widen rather than narrow — this map is passed straight back.
            const byKey = new Map<string, unknown>();
            for (const p of current.parameter ?? []) if (p.key) byKey.set(p.key, p);
            for (const p of input.parameter) if (p.key) byKey.set(p.key, p);
            return [...byKey.values()];
          })();

          const preserved = (
            ["parameter", "firingTriggerId", "blockingTriggerId", "paused", "notes"] as const
          ).filter((k) => input[k] === undefined);

          const res = await client.accounts.containers.workspaces.tags.update({
            path: input.tagPath,
            requestBody: {
              name: input.name,
              type: input.type,
              parameter: mergedParameter as never,
              firingTriggerId: pick(input.firingTriggerId, current.firingTriggerId ?? undefined),
              blockingTriggerId: pick(input.blockingTriggerId, current.blockingTriggerId ?? undefined),
              paused: pick(input.paused, current.paused ?? undefined),
              notes: pick(input.notes, current.notes ?? undefined),
            },
          });

          return {
            updated: true,
            reversible: true,
            affectsLiveSite: false,
            merged: true,
            preservedFields: preserved,
            note:
              "Workspace-only change. Not live until published. " +
              (preserved.length
                ? `Preserved from the existing tag: ${preserved.join(", ")}. To clear a field instead, pass it explicitly as an empty array.`
                : "Every field was supplied explicitly."),
            tag: {
              path: res.data.path ?? "",
              tagId: res.data.tagId ?? "",
              name: res.data.name ?? "",
              type: res.data.type ?? "",
              paused: res.data.paused ?? false,
            },
          };
        } catch (err) {
          throw mapGoogleError(err, "update the Tag Manager tag");
        }
      },
    },

    {
      name: "gtm_create_trigger",
      title: "Create a trigger in a workspace",
      description:
        "CHANGES A WORKSPACE. Creates a trigger in a Tag Manager workspace. " +
        "REVERSIBLE: workspace-only until published. " +
        "A trigger on its own fires nothing — it must be referenced by a tag's firingTriggerId.",
      inputSchema: gtmCreateTriggerSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          path?: string;
          accountId?: string;
          containerId?: string;
          workspaceId?: string;
          name: string;
          type: string;
          filter?: unknown[];
          customEventFilter?: unknown[];
          notes?: string;
        }>(raw, gtmCreateTriggerSchema, "gtm_create_trigger");

        const ws = normalizeWorkspacePath(input, "gtm_create_trigger");

        try {
          const client = await gtm();
          const res = await client.accounts.containers.workspaces.triggers.create({
            parent: ws.path,
            requestBody: {
              name: input.name,
              type: input.type,
              filter: input.filter as never,
              customEventFilter: input.customEventFilter as never,
              notes: input.notes,
            },
          });

          return {
            created: true,
            reversible: true,
            affectsLiveSite: false,
            trigger: {
              path: res.data.path ?? "",
              triggerId: res.data.triggerId ?? "",
              name: res.data.name ?? "",
              type: res.data.type ?? "",
            },
          };
        } catch (err) {
          throw mapGoogleError(err, "create the Tag Manager trigger");
        }
      },
    },

    {
      name: "gtm_create_version",
      title: "Snapshot a workspace into a container version",
      description:
        "CHANGES CONFIGURATION. Freezes the current workspace state into an immutable container version. " +
        "SAFE: creating a version does NOT publish it and does NOT affect any live site. It is the staging step " +
        "before gtm_publish_version. " +
        "Returns the version ID needed to publish. Always supply `notes` — this is the audit trail for the change.",
      inputSchema: gtmCreateVersionSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          path?: string;
          accountId?: string;
          containerId?: string;
          workspaceId?: string;
          name?: string;
          notes?: string;
        }>(raw, gtmCreateVersionSchema, "gtm_create_version");

        const ws = normalizeWorkspacePath(input, "gtm_create_version");

        try {
          const client = await gtm();
          const res = await client.accounts.containers.workspaces.create_version({
            path: ws.path,
            requestBody: {
              name: input.name ?? `gmcp ${new Date().toISOString()}`,
              notes: input.notes,
            },
          });

          const version = res.data.containerVersion;
          // GTM reports compiler errors in the response body rather than as an
          // HTTP error. A version can be created and still be broken.
          if (res.data.compilerError) {
            return {
              created: false,
              compilerError: true,
              note: "GTM reported a compiler error. The version was not created cleanly — fix the workspace before publishing.",
              syncStatus: res.data.syncStatus ?? undefined,
            };
          }

          return {
            created: true,
            published: false,
            affectsLiveSite: false,
            note: "Version created but NOT published. Call gtm_publish_version to review what would go live; it will not publish without confirm: true.",
            version: {
              path: version?.path ?? "",
              containerVersionId: version?.containerVersionId ?? "",
              name: version?.name ?? "",
              // Asymmetric API: create_version takes `notes` in the request,
              // but the stored ContainerVersion exposes it as `description`.
              notes: version?.description ?? "",
              tagCount: (version?.tag ?? []).length,
              triggerCount: (version?.trigger ?? []).length,
              variableCount: (version?.variable ?? []).length,
            },
          };
        } catch (err) {
          throw mapGoogleError(err, "create the Tag Manager container version");
        }
      },
    },

    {
      name: "gtm_publish_version",
      title: "Publish a container version to the live site",
      description:
        "PUBLISHES TO THE LIVE WEBSITE. This is the highest-impact operation in this server — it changes tracking " +
        "on every page where the container is installed. " +
        "REQUIRES confirm: true. When confirm is false or omitted this performs a DRY RUN: it returns what would " +
        "go live and the delta against the currently live version, and publishes NOTHING. " +
        "Show that summary to a human and get explicit approval before calling again with confirm: true. " +
        "Do not set confirm: true on your own initiative. " +
        "REVERSIBLE: GTM keeps version history, so an earlier version can be republished to roll back.",
      inputSchema: gtmPublishVersionSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          versionPath?: string;
          accountId?: string;
          containerId?: string;
          versionId?: string;
          confirm?: boolean;
        }>(raw, gtmPublishVersionSchema, "gtm_publish_version");

        // Resolve the version path from either form.
        let versionPath: string;
        if (input.versionPath) {
          if (!/^accounts\/[^/]+\/containers\/[^/]+\/versions\/[^/]+$/.test(input.versionPath)) {
            throw new ValidationError(
              `gtm_publish_version: "${input.versionPath}" is not a version path.`,
              "Expected 'accounts/{a}/containers/{c}/versions/{versionId}'.",
            );
          }
          versionPath = input.versionPath;
        } else {
          const { accountId, containerId, versionId } = input;
          if (!accountId || !containerId || !versionId) {
            const missing = [
              !accountId && "accountId",
              !containerId && "containerId",
              !versionId && "versionId",
            ].filter(Boolean);
            throw new ValidationError(
              `gtm_publish_version: missing ${missing.join(", ")}.`,
              "Supply either `versionPath`, or all of accountId, containerId and versionId. gtm_create_version returns the path.",
            );
          }
          versionPath = `accounts/${accountId}/containers/${containerId}/versions/${versionId}`;
        }

        const containerPath = versionPath.replace(/\/versions\/[^/]+$/, "");

        try {
          const client = await gtm();

          // ---- DRY RUN (handover D6) -------------------------------------
          // No publish call is made on this path. Phase 4 asserts that with a spy.
          if (input.confirm !== true) {
            const candidateRes = await client.accounts.containers.versions.get({
              path: versionPath,
            });
            const candidate = candidateRes.data;

            let live: typeof candidate | undefined;
            try {
              const liveRes = await client.accounts.containers.versions.live({
                parent: containerPath,
              });
              live = liveRes.data;
            } catch {
              // No live version yet — this would be the container's first publish.
              live = undefined;
            }

            const tagDiff = diffNames(live?.tag, candidate.tag);
            const triggerDiff = diffNames(live?.trigger, candidate.trigger);
            const variableDiff = diffNames(live?.variable, candidate.variable);

            return {
              published: false,
              dryRun: true,
              confirmRequired: true,
              instruction:
                "NOTHING WAS PUBLISHED. Show this summary to a human. Only if they explicitly approve, call " +
                "gtm_publish_version again with confirm: true. Do not decide this yourself.",
              wouldPublish: {
                versionPath,
                containerVersionId: candidate.containerVersionId ?? "",
                name: candidate.name ?? "",
                notes: candidate.description ?? "",
                tagCount: (candidate.tag ?? []).length,
                triggerCount: (candidate.trigger ?? []).length,
                variableCount: (candidate.variable ?? []).length,
              },
              currentlyLive: live
                ? {
                    containerVersionId: live.containerVersionId ?? "",
                    name: live.name ?? "",
                    tagCount: (live.tag ?? []).length,
                    triggerCount: (live.trigger ?? []).length,
                    variableCount: (live.variable ?? []).length,
                  }
                : null,
              delta: live
                ? {
                    tags: tagDiff,
                    triggers: triggerDiff,
                    variables: variableDiff,
                  }
                : {
                    note: "No version is currently live. This would be the container's FIRST publish — everything in it becomes live at once.",
                  },
            };
          }

          // ---- CONFIRMED PUBLISH -----------------------------------------
          const res = await client.accounts.containers.versions.publish({
            path: versionPath,
          });

          return {
            published: true,
            reversible: true,
            affectsLiveSite: true,
            note: "This is now live on every page where the container is installed. To roll back, publish an earlier version from the GTM UI (Versions tab) — GTM retains version history.",
            liveVersion: {
              path: res.data.containerVersion?.path ?? "",
              containerVersionId: res.data.containerVersion?.containerVersionId ?? "",
              name: res.data.containerVersion?.name ?? "",
            },
            compilerError: res.data.compilerError ?? false,
          };
        } catch (err) {
          throw mapGoogleError(err, "publish the Tag Manager container version");
        }
      },
    },
  ];
}
