/**
 * JSON Schemas for the write tools.
 *
 * These tools change live configuration. Every schema here is deliberately
 * strict — `additionalProperties: false` plus enums wherever Google accepts a
 * closed set, so a malformed call fails locally rather than half-applying.
 */

// ---------------------------------------------------------------- GA4 Admin

export const ga4CreateCustomDimensionSchema = {
  type: "object",
  properties: {
    propertyId: {
      type: "string",
      description: "Numeric GA4 property ID. Call ga4_list_account_summaries to discover it.",
    },
    parameterName: {
      type: "string",
      description:
        "The event parameter or user property name to register, e.g. 'article_author'. Must already be being sent by your tagging; creating the dimension does not start collection.",
    },
    displayName: {
      type: "string",
      description: "Human-readable name shown in GA4 reports. Max 82 characters.",
    },
    scope: {
      type: "string",
      enum: ["EVENT", "USER", "ITEM"],
      description:
        "EVENT for event parameters, USER for user properties, ITEM for ecommerce item parameters. Cannot be changed after creation.",
    },
    description: {
      type: "string",
      description: "Optional description. Max 150 characters.",
    },
    disallowAdsPersonalization: {
      type: "boolean",
      description: "USER-scoped only. Marks the dimension as NPA (no ads personalization).",
    },
  },
  required: ["propertyId", "parameterName", "displayName", "scope"],
  additionalProperties: false,
} as const;

export const ga4CreateKeyEventSchema = {
  type: "object",
  properties: {
    propertyId: { type: "string", description: "Numeric GA4 property ID." },
    eventName: {
      type: "string",
      description:
        "The event name to mark as a key event, e.g. 'purchase' or 'generate_lead'. The event must already exist or be collected in future.",
    },
    countingMethod: {
      type: "string",
      enum: ["ONCE_PER_EVENT", "ONCE_PER_SESSION"],
      description:
        "ONCE_PER_EVENT counts every occurrence. ONCE_PER_SESSION counts at most one per session.",
    },
  },
  required: ["propertyId", "eventName", "countingMethod"],
  additionalProperties: false,
} as const;

export const ga4UpdateKeyEventSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Full resource name of the key event, e.g. 'properties/123/keyEvents/456'. Get it from ga4_list_key_events.",
    },
    countingMethod: {
      type: "string",
      enum: ["ONCE_PER_EVENT", "ONCE_PER_SESSION"],
      description: "New counting method.",
    },
  },
  required: ["name", "countingMethod"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------- Search Console

export const gscSubmitSitemapSchema = {
  type: "object",
  properties: {
    siteUrl: {
      type: "string",
      description:
        "Exact Search Console property string. Call gsc_list_sites for valid values.",
    },
    feedpath: {
      type: "string",
      description:
        "Fully-qualified sitemap URL, e.g. 'https://example.com/sitemap.xml'. Must be within the property.",
    },
  },
  required: ["siteUrl", "feedpath"],
  additionalProperties: false,
} as const;

// -------------------------------------------------------------- Tag Manager

/** GTM parameters are [{type, key, value}]; accept that shape directly. */
const gtmParameter = {
  type: "array",
  items: { type: "object" },
  description:
    "GTM parameter array: [{ type: 'template'|'boolean'|'integer'|'list'|'map', key: string, value: string }]. " +
    "For a Custom HTML tag use [{ type: 'template', key: 'html', value: '<script>...</script>' }].",
} as const;

const workspaceTarget = {
  path: {
    type: "string",
    description: "Full workspace path 'accounts/{a}/containers/{c}/workspaces/{w}'.",
  },
  accountId: { type: "string", description: "GTM account ID. Ignored if `path` is supplied." },
  containerId: { type: "string", description: "Numeric internal container ID, not GTM-XXXXXXX." },
  workspaceId: { type: "string", description: "Workspace ID from gtm_list_workspaces." },
} as const;

export const gtmCreateTagSchema = {
  type: "object",
  properties: {
    ...workspaceTarget,
    name: { type: "string", description: "Tag name, unique within the workspace." },
    type: {
      type: "string",
      description:
        "GTM tag type code, e.g. 'html' (Custom HTML), 'gaawe' (GA4 Event), 'gaawc' (GA4 Config). " +
        "Call gtm_list_tags on an existing container to see the codes GTM uses.",
    },
    parameter: gtmParameter,
    firingTriggerId: {
      type: "array",
      items: { type: "string" },
      description: "Trigger IDs that fire this tag. Get them from gtm_list_triggers.",
    },
    blockingTriggerId: {
      type: "array",
      items: { type: "string" },
      description: "Trigger IDs that block this tag.",
    },
    paused: {
      type: "boolean",
      description: "Create the tag paused. Recommended when an agent creates a tag unattended.",
    },
    notes: { type: "string", description: "Free-text notes stored on the tag." },
  },
  required: ["name", "type"],
  additionalProperties: false,
} as const;

export const gtmUpdateTagSchema = {
  type: "object",
  properties: {
    tagPath: {
      type: "string",
      description:
        "Full tag path 'accounts/{a}/containers/{c}/workspaces/{w}/tags/{id}'. Get it from gtm_list_tags.",
    },
    name: { type: "string", description: "New tag name." },
    type: { type: "string", description: "GTM tag type code. Required by the API on update." },
    parameter: gtmParameter,
    firingTriggerId: { type: "array", items: { type: "string" }, description: "Replacement firing triggers." },
    blockingTriggerId: { type: "array", items: { type: "string" }, description: "Replacement blocking triggers." },
    paused: { type: "boolean", description: "Pause or unpause the tag." },
    notes: { type: "string", description: "Free-text notes." },
  },
  required: ["tagPath", "name", "type"],
  additionalProperties: false,
} as const;

export const gtmCreateTriggerSchema = {
  type: "object",
  properties: {
    ...workspaceTarget,
    name: { type: "string", description: "Trigger name, unique within the workspace." },
    type: {
      type: "string",
      description:
        "GTM trigger type code, e.g. 'pageview', 'domReady', 'windowLoaded', 'click', 'linkClick', 'customEvent', 'formSubmission'.",
    },
    filter: {
      type: "array",
      items: { type: "object" },
      description:
        "Conditions: [{ type: 'equals'|'contains'|'startsWith'|..., parameter: [{type:'template',key:'arg0',value:'{{Page Path}}'},{type:'template',key:'arg1',value:'/checkout'}] }].",
    },
    customEventFilter: {
      type: "array",
      items: { type: "object" },
      description: "For customEvent triggers: the event-name matching conditions.",
    },
    notes: { type: "string", description: "Free-text notes." },
  },
  required: ["name", "type"],
  additionalProperties: false,
} as const;

export const gtmCreateVersionSchema = {
  type: "object",
  properties: {
    ...workspaceTarget,
    name: { type: "string", description: "Version name. Defaults to a timestamped name." },
    notes: {
      type: "string",
      description: "Version notes. Strongly recommended — this is the audit trail for the change.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;

export const gtmPublishVersionSchema = {
  type: "object",
  properties: {
    versionPath: {
      type: "string",
      description:
        "Full version path 'accounts/{a}/containers/{c}/versions/{id}'. Returned by gtm_create_version.",
    },
    accountId: { type: "string", description: "GTM account ID. Ignored if versionPath is supplied." },
    containerId: { type: "string", description: "Numeric internal container ID." },
    versionId: { type: "string", description: "Container version ID." },
    confirm: {
      type: "boolean",
      description:
        "MUST be true to publish. When false or omitted, this tool performs a DRY RUN: it returns a summary of " +
        "what would go live and the delta against the currently live version, and publishes nothing. " +
        "Only set true after a human has reviewed that summary.",
    },
  },
  required: [],
  additionalProperties: false,
} as const;
