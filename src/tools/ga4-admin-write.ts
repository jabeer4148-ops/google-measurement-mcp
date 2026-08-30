/**
 * GA4 Admin write tools (analyticsadmin v1beta).
 *
 * Registered only when write mode is enabled (see docs/DESIGN.md §1).
 *
 * NOT implemented, by design (see docs/DESIGN.md §2): archiving custom dimensions,
 * deleting key events, and any property or data-stream mutation. An agent
 * cannot call what does not exist.
 */

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { ValidationError, mapGoogleError } from "../errors.js";
import { normalizePropertyId } from "../lib/normalize.js";
import { validateInput } from "../lib/validate.js";
import {
  ga4CreateCustomDimensionSchema,
  ga4CreateKeyEventSchema,
  ga4UpdateKeyEventSchema,
} from "../schemas/phase3.js";
import type { ToolDefinition } from "../schemas/index.js";

export function createGa4AdminWriteTools(
  getClient: () => Promise<OAuth2Client>,
  _config: Config,
): ToolDefinition[] {
  const admin = async () =>
    google.analyticsadmin({ version: "v1beta", auth: await getClient() });

  return [
    {
      name: "ga4_create_custom_dimension",
      title: "Create a GA4 custom dimension",
      description:
        "CHANGES CONFIGURATION. Creates a custom dimension on a GA4 property. " +
        "NOT REVERSIBLE: GA4 custom dimensions can only be ARCHIVED, never deleted, and this server does not " +
        "implement archiving. Slots are limited (typically 50 event-scoped and 25 user-scoped per property) and " +
        "an archived dimension still consumes its slot. " +
        "Do NOT create dimensions speculatively — confirm with the user that the parameter is actually being " +
        "collected and that they want it registered. " +
        "Note that creating a dimension does not start data collection; your tagging must already send the parameter, " +
        "and data only appears going forward, never retroactively.",
      inputSchema: ga4CreateCustomDimensionSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          propertyId: string;
          parameterName: string;
          displayName: string;
          scope: "EVENT" | "USER" | "ITEM";
          description?: string;
          disallowAdsPersonalization?: boolean;
        }>(raw, ga4CreateCustomDimensionSchema, "ga4_create_custom_dimension");

        const parent = normalizePropertyId(input.propertyId, "ga4_create_custom_dimension");

        // Enforce Google's documented limits locally so the failure is legible
        // rather than an opaque 400.
        if (input.displayName.length > 82) {
          throw new ValidationError(
            `ga4_create_custom_dimension: displayName is ${input.displayName.length} characters; GA4 allows 82.`,
          );
        }
        if (input.description && input.description.length > 150) {
          throw new ValidationError(
            `ga4_create_custom_dimension: description is ${input.description.length} characters; GA4 allows 150.`,
          );
        }
        if (input.disallowAdsPersonalization && input.scope !== "USER") {
          throw new ValidationError(
            "ga4_create_custom_dimension: disallowAdsPersonalization applies only to USER-scoped dimensions.",
          );
        }

        try {
          const client = await admin();
          const res = await client.properties.customDimensions.create({
            parent,
            requestBody: {
              parameterName: input.parameterName,
              displayName: input.displayName,
              scope: input.scope,
              description: input.description,
              disallowAdsPersonalization: input.disallowAdsPersonalization,
            },
          });

          return {
            created: true,
            reversible: false,
            note: "This dimension cannot be deleted. It can only be archived, from the GA4 UI, and an archived dimension still consumes a slot.",
            customDimension: {
              name: res.data.name ?? "",
              parameterName: res.data.parameterName ?? "",
              displayName: res.data.displayName ?? "",
              scope: res.data.scope ?? "",
              description: res.data.description ?? "",
            },
          };
        } catch (err) {
          throw mapGoogleError(err, "create the GA4 custom dimension");
        }
      },
    },

    {
      name: "ga4_create_key_event",
      title: "Create a GA4 key event",
      description:
        "CHANGES CONFIGURATION. Marks an event as a key event (formerly 'conversion') on a GA4 property. " +
        "REVERSIBLE, but not by this server: key events can be deleted, however deletion is deliberately not " +
        "implemented here — remove it from the GA4 UI if unwanted. " +
        "Marking a key event affects reporting and any Google Ads bidding that consumes it, so confirm intent " +
        "with the user before calling.",
      inputSchema: ga4CreateKeyEventSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          propertyId: string;
          eventName: string;
          countingMethod: "ONCE_PER_EVENT" | "ONCE_PER_SESSION";
        }>(raw, ga4CreateKeyEventSchema, "ga4_create_key_event");

        const parent = normalizePropertyId(input.propertyId, "ga4_create_key_event");

        try {
          const client = await admin();
          const res = await client.properties.keyEvents.create({
            parent,
            requestBody: {
              eventName: input.eventName,
              countingMethod: input.countingMethod,
            },
          });

          return {
            created: true,
            reversible: true,
            note: "Deletable from the GA4 UI. This server does not implement deletion by design.",
            keyEvent: {
              name: res.data.name ?? "",
              eventName: res.data.eventName ?? "",
              countingMethod: res.data.countingMethod ?? "",
              custom: res.data.custom ?? false,
              deletable: res.data.deletable ?? false,
            },
          };
        } catch (err) {
          throw mapGoogleError(err, "create the GA4 key event");
        }
      },
    },

    {
      name: "ga4_update_key_event",
      title: "Update a GA4 key event",
      description:
        "CHANGES CONFIGURATION. Updates the counting method of an existing key event. " +
        "REVERSIBLE: call again with the previous value to restore it. " +
        "Requires the full resource name from ga4_list_key_events, not just the event name.",
      inputSchema: ga4UpdateKeyEventSchema as unknown as Record<string, unknown>,
      write: true,
      handler: async (raw: unknown) => {
        const input = validateInput<{
          name: string;
          countingMethod: "ONCE_PER_EVENT" | "ONCE_PER_SESSION";
        }>(raw, ga4UpdateKeyEventSchema, "ga4_update_key_event");

        if (!/^properties\/\d+\/keyEvents\/.+/.test(input.name)) {
          throw new ValidationError(
            `ga4_update_key_event: "${input.name}" is not a key event resource name.`,
            "Expected 'properties/{propertyId}/keyEvents/{keyEventId}'. Call ga4_list_key_events to get it.",
          );
        }

        try {
          const client = await admin();
          const res = await client.properties.keyEvents.patch({
            name: input.name,
            updateMask: "countingMethod",
            requestBody: { countingMethod: input.countingMethod },
          });

          return {
            updated: true,
            reversible: true,
            keyEvent: {
              name: res.data.name ?? "",
              eventName: res.data.eventName ?? "",
              countingMethod: res.data.countingMethod ?? "",
            },
          };
        } catch (err) {
          throw mapGoogleError(err, "update the GA4 key event");
        }
      },
    },
  ];
}
