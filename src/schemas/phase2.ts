/**
 * JSON Schemas for the read tools.
 *
 * Single source of truth (see docs/DESIGN.md): registration references these objects and
 * `validateInput` enforces them. Never redeclare a shape at a call site.
 */

const limit = {
  type: "integer",
  minimum: 1,
  description:
    "Maximum rows to return. Defaults to 25 to protect the context window. Prefer narrowing the query over raising this.",
} as const;

const pageToken = {
  type: "string",
  description:
    "Opaque token from a previous response's `nextPageToken`, to fetch the following page. Paging is manual so the caller controls cost.",
} as const;

// ---------------------------------------------------------------- GA4 Data

export const ga4RealtimeReportSchema = {
  type: "object",
  properties: {
    propertyId: {
      type: "string",
      description:
        "Numeric GA4 property ID, with or without the 'properties/' prefix. Not the G-XXXXXXX measurement ID.",
    },
    dimensions: {
      type: "array",
      items: { type: "string" },
      description:
        "Realtime dimension API names, e.g. ['country','unifiedScreenName','deviceCategory']. Note the realtime schema is a SUBSET of the standard reporting schema — 'date' and most session-scoped dimensions are unavailable.",
    },
    metrics: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Realtime metric API names, e.g. ['activeUsers','screenPageViews'].",
    },
    limit,
  },
  required: ["propertyId", "metrics"],
  additionalProperties: false,
} as const;

// --------------------------------------------------------------- GA4 Admin

export const ga4ListAccountSummariesSchema = {
  type: "object",
  properties: { limit, pageToken },
  required: [],
  additionalProperties: false,
} as const;

export const ga4PropertyOnlySchema = {
  type: "object",
  properties: {
    propertyId: {
      type: "string",
      description:
        "Numeric GA4 property ID, with or without the 'properties/' prefix. Call ga4_list_account_summaries to discover it.",
    },
    limit,
    pageToken,
  },
  required: ["propertyId"],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------- Search Console

export const gscListSitesSchema = {
  type: "object",
  properties: { limit },
  required: [],
  additionalProperties: false,
} as const;

export const gscSearchAnalyticsSchema = {
  type: "object",
  properties: {
    siteUrl: {
      type: "string",
      description:
        "Exact property string from Search Console: 'https://example.com/' (URL-prefix) or 'sc-domain:example.com' (Domain). Call gsc_list_sites for valid values.",
    },
    startDate: { type: "string", description: "YYYY-MM-DD. Relative dates are NOT supported." },
    endDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
    dimensions: {
      type: "array",
      items: {
        type: "string",
        enum: ["query", "page", "country", "device", "searchAppearance", "date", "hour"],
      },
      description:
        "Group by these. 'hour' requires dataState='hourly_all'. Results are keyed in the order supplied.",
    },
    type: {
      type: "string",
      enum: ["web", "image", "video", "news", "googleNews", "discover"],
      description: "Search surface. Defaults to 'web'. Replaces the deprecated `searchType`.",
    },
    dimensionFilterGroups: {
      type: "array",
      items: { type: "object" },
      description:
        "Filter groups: [{ groupType: 'and', filters: [{ dimension, operator, expression }] }]. Operators: contains, equals, notContains, notEquals, includingRegex, excludingRegex (RE2 syntax). You may filter on a dimension without grouping by it.",
    },
    aggregationType: {
      type: "string",
      enum: ["auto", "byPage", "byProperty", "byNewsShowcasePanel"],
      description: "Defaults to 'auto'. Cannot be 'byProperty' when grouping or filtering by page.",
    },
    dataState: {
      type: "string",
      enum: ["final", "all", "hourly_all"],
      description:
        "'final' (default) excludes incomplete data. 'all' includes fresh partial data. 'hourly_all' enables the 'hour' dimension.",
    },
    startRow: {
      type: "integer",
      minimum: 0,
      description: "Zero-based offset for paging. Search Console uses an offset, not a page token.",
    },
    limit,
  },
  required: ["siteUrl", "startDate", "endDate"],
  additionalProperties: false,
} as const;

export const gscSiteOnlySchema = {
  type: "object",
  properties: {
    siteUrl: {
      type: "string",
      description:
        "Exact property string from Search Console. Call gsc_list_sites for valid values.",
    },
    limit,
  },
  required: ["siteUrl"],
  additionalProperties: false,
} as const;

export const gscInspectUrlSchema = {
  type: "object",
  properties: {
    siteUrl: {
      type: "string",
      description: "The Search Console property that owns the URL being inspected.",
    },
    inspectionUrl: {
      type: "string",
      description:
        "Fully-qualified URL to inspect. Must belong to the siteUrl property.",
    },
    languageCode: {
      type: "string",
      description: "BCP-47 code for localized result text, e.g. 'en-US'. Optional.",
    },
  },
  required: ["siteUrl", "inspectionUrl"],
  additionalProperties: false,
} as const;

// -------------------------------------------------------------- Tag Manager

export const gtmListAccountsSchema = {
  type: "object",
  properties: { limit, pageToken },
  required: [],
  additionalProperties: false,
} as const;

export const gtmListContainersSchema = {
  type: "object",
  properties: {
    accountId: {
      type: "string",
      description: "GTM account ID, with or without the 'accounts/' prefix. Call gtm_list_accounts to discover it.",
    },
    limit,
    pageToken,
  },
  required: ["accountId"],
  additionalProperties: false,
} as const;

export const gtmListWorkspacesSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Full container path 'accounts/{a}/containers/{c}'. Alternative to supplying accountId and containerId separately.",
    },
    accountId: { type: "string", description: "GTM account ID. Ignored if `path` is supplied." },
    containerId: {
      type: "string",
      description:
        "GTM container ID — the NUMERIC internal ID from gtm_list_containers, not the GTM-XXXXXXX public ID.",
    },
    limit,
    pageToken,
  },
  required: [],
  additionalProperties: false,
} as const;

export const gtmWorkspaceEntitySchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Full workspace path 'accounts/{a}/containers/{c}/workspaces/{w}'. Alternative to the three IDs.",
    },
    accountId: { type: "string", description: "GTM account ID. Ignored if `path` is supplied." },
    containerId: {
      type: "string",
      description: "Numeric internal container ID, not GTM-XXXXXXX.",
    },
    workspaceId: { type: "string", description: "Workspace ID from gtm_list_workspaces." },
    limit,
    pageToken,
  },
  required: [],
  additionalProperties: false,
} as const;
