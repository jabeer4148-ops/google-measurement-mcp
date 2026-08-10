/**
 * Tag Manager tools (tagmanager v2). Read-only.
 *
 * Every tool here reads a workspace, never the live container.
 *
 * QUOTA: the GTM API enforces strict per-user limits and returns 429 readily.
 * Google's own guidance is to space container-mutating calls minutes apart. Read
 * calls are cheaper but still counted — descriptions warn against fan-out loops.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { mapGoogleError } from "../errors.js";
import { resolveLimit, truncateRows } from "../lib/truncate.js";
import {
  normalizeContainerPath,
  normalizeGtmAccountPath,
  normalizeWorkspacePath,
} from "../lib/normalize.js";
import { validateInput } from "../lib/validate.js";
import {
  gtmListAccountsSchema,
  gtmListContainersSchema,
  gtmListWorkspacesSchema,
  gtmWorkspaceEntitySchema,
} from "../schemas/phase2.js";
import type { ToolDefinition } from "../schemas/index.js";

interface WorkspaceEntityInput {
  path?: string;
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  limit?: number;
  pageToken?: string;
}

/** Condense GTM's verbose parameter arrays into readable key/value pairs. */
function summarizeParameters(
  params: Array<{ key?: string | null; value?: string | null; type?: string | null }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params ?? []) {
    if (p.key) out[p.key] = p.value ?? `(${p.type ?? "unset"})`;
  }
  return out;
}

export function createGtmTools(
  getClient: () => Promise<OAuth2Client>,
  config: Config,
): ToolDefinition[] {
  const gtm = async () => google.tagmanager({ version: "v2", auth: await getClient() });
  const cap = (n?: number) => resolveLimit(n, config.defaultRowLimit, config.maxRowLimit);

  /** Shared handler shape for the three workspace-scoped entity listings. */
  const workspaceEntityTool = (
    name: string,
    title: string,
    description: string,
    fetch: (
      client: ReturnType<typeof google.tagmanager>,
      parent: string,
      max: number,
      pageToken: string | undefined,
    ) => Promise<{ rows: Record<string, unknown>[]; nextPageToken?: string }>,
    context: string,
  ): ToolDefinition => ({
    name,
    title,
    description,
    inputSchema: gtmWorkspaceEntitySchema as unknown as Record<string, unknown>,
    write: false,
    handler: async (raw: unknown) => {
      const input = validateInput<WorkspaceEntityInput>(raw, gtmWorkspaceEntitySchema, name);
      const ws = normalizeWorkspacePath(input, name);
      const max = cap(input.limit);
      try {
        const client = await gtm();
        const { rows, nextPageToken } = await fetch(client, ws.path, max, input.pageToken);
        return { workspace: ws.path, ...truncateRows(rows, max), nextPageToken };
      } catch (err) {
        throw mapGoogleError(err, context);
      }
    },
  });

  return [
    {
      name: "gtm_list_accounts",
      title: "List Tag Manager accounts",
      description:
        "Lists every Google Tag Manager account the authenticated user can access. " +
        "Use this FIRST to discover accountId, then gtm_list_containers, then gtm_list_workspaces. Read-only.",
      inputSchema: gtmListAccountsSchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validateInput<{ limit?: number; pageToken?: string }>(
          raw,
          gtmListAccountsSchema,
          "gtm_list_accounts",
        );
        const max = cap(input.limit);
        try {
          const client = await gtm();
          const res = await client.accounts.list({ pageToken: input.pageToken });
          const rows = (res.data.account ?? []).map((a) => ({
            path: a.path ?? "",
            accountId: a.accountId ?? "",
            name: a.name ?? "",
            shareData: a.shareData ?? false,
          }));
          return { ...truncateRows(rows, max), nextPageToken: res.data.nextPageToken ?? undefined };
        } catch (err) {
          throw mapGoogleError(err, "list Tag Manager accounts");
        }
      },
    },

    {
      name: "gtm_list_containers",
      title: "List Tag Manager containers",
      description:
        "Lists containers in a Tag Manager account. Call gtm_list_accounts first to get the accountId. " +
        "NOTE the response has two different IDs: `containerId` is the numeric internal ID that every other GTM tool " +
        "needs, while `publicId` is the GTM-XXXXXXX string shown in the UI. Pass the numeric one. Read-only.",
      inputSchema: gtmListContainersSchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validateInput<{ accountId: string; limit?: number; pageToken?: string }>(
          raw,
          gtmListContainersSchema,
          "gtm_list_containers",
        );
        const parent = normalizeGtmAccountPath(input.accountId, "gtm_list_containers");
        const max = cap(input.limit);
        try {
          const client = await gtm();
          const res = await client.accounts.containers.list({
            parent,
            pageToken: input.pageToken,
          });
          const rows = (res.data.container ?? []).map((c) => ({
            path: c.path ?? "",
            accountId: c.accountId ?? "",
            containerId: c.containerId ?? "",
            publicId: c.publicId ?? "",
            name: c.name ?? "",
            usageContext: c.usageContext ?? [],
            domainName: c.domainName ?? [],
          }));
          return {
            account: parent,
            ...truncateRows(rows, max),
            nextPageToken: res.data.nextPageToken ?? undefined,
          };
        } catch (err) {
          throw mapGoogleError(err, "list Tag Manager containers");
        }
      },
    },

    {
      name: "gtm_list_workspaces",
      title: "List Tag Manager workspaces",
      description:
        "Lists workspaces in a container. Workspaces are the safe editing surface — all writes in this server " +
        "operate on a workspace, never the live container. " +
        "Accepts either a full container `path` or accountId + containerId (numeric internal ID). Read-only.",
      inputSchema: gtmListWorkspacesSchema as unknown as Record<string, unknown>,
      write: false,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          path?: string;
          accountId?: string;
          containerId?: string;
          limit?: number;
          pageToken?: string;
        }>(raw, gtmListWorkspacesSchema, "gtm_list_workspaces");

        const container = normalizeContainerPath(input, "gtm_list_workspaces");
        const max = cap(input.limit);
        try {
          const client = await gtm();
          const res = await client.accounts.containers.workspaces.list({
            parent: container.path,
            pageToken: input.pageToken,
          });
          const rows = (res.data.workspace ?? []).map((w) => ({
            path: w.path ?? "",
            workspaceId: w.workspaceId ?? "",
            name: w.name ?? "",
            description: w.description ?? "",
          }));
          return {
            container: container.path,
            ...truncateRows(rows, max),
            nextPageToken: res.data.nextPageToken ?? undefined,
          };
        } catch (err) {
          throw mapGoogleError(err, "list Tag Manager workspaces");
        }
      },
    },

    workspaceEntityTool(
      "gtm_list_tags",
      "List tags in a workspace",
      "Lists tags in a Tag Manager workspace with their type, firing triggers and parameters. " +
        "Accepts a full workspace `path` or accountId + containerId + workspaceId. " +
        "Parameters are condensed to key/value pairs for readability. Read-only.",
      async (client, parent, max, pageToken) => {
        const res = await client.accounts.containers.workspaces.tags.list({ parent, pageToken });
        return {
          rows: (res.data.tag ?? []).map((t) => ({
            path: t.path ?? "",
            tagId: t.tagId ?? "",
            name: t.name ?? "",
            type: t.type ?? "",
            firingTriggerId: t.firingTriggerId ?? [],
            blockingTriggerId: t.blockingTriggerId ?? [],
            paused: t.paused ?? false,
            parameter: summarizeParameters(t.parameter ?? undefined),
          })),
          nextPageToken: res.data.nextPageToken ?? undefined,
        };
      },
      "list Tag Manager tags",
    ),

    workspaceEntityTool(
      "gtm_list_triggers",
      "List triggers in a workspace",
      "Lists triggers in a Tag Manager workspace with their type and firing conditions. " +
        "Accepts a full workspace `path` or accountId + containerId + workspaceId. Read-only.",
      async (client, parent, max, pageToken) => {
        const res = await client.accounts.containers.workspaces.triggers.list({ parent, pageToken });
        return {
          rows: (res.data.trigger ?? []).map((t) => ({
            path: t.path ?? "",
            triggerId: t.triggerId ?? "",
            name: t.name ?? "",
            type: t.type ?? "",
            filter: (t.filter ?? []).map((f) => ({
              type: f.type ?? "",
              parameter: summarizeParameters(f.parameter ?? undefined),
            })),
            customEventFilter: (t.customEventFilter ?? []).map((f) => ({
              type: f.type ?? "",
              parameter: summarizeParameters(f.parameter ?? undefined),
            })),
          })),
          nextPageToken: res.data.nextPageToken ?? undefined,
        };
      },
      "list Tag Manager triggers",
    ),

    workspaceEntityTool(
      "gtm_list_variables",
      "List variables in a workspace",
      "Lists user-defined variables in a Tag Manager workspace with their type and parameters. " +
        "Note this returns user-defined variables only — built-in variables are a separate collection. " +
        "Accepts a full workspace `path` or accountId + containerId + workspaceId. Read-only.",
      async (client, parent, max, pageToken) => {
        const res = await client.accounts.containers.workspaces.variables.list({
          parent,
          pageToken,
        });
        return {
          rows: (res.data.variable ?? []).map((v) => ({
            path: v.path ?? "",
            variableId: v.variableId ?? "",
            name: v.name ?? "",
            type: v.type ?? "",
            parameter: summarizeParameters(v.parameter ?? undefined),
          })),
          nextPageToken: res.data.nextPageToken ?? undefined,
        };
      },
      "list Tag Manager variables",
    ),
  ];
}
