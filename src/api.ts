// Talking to Jira Cloud, and the settings that say where and as whom.
//
// Requests go through Deck's `httpSend` (Rust/reqwest) rather than the webview's fetch: Jira
// sends no CORS headers for a browser origin, so fetch cannot reach it at all. The same call
// from Rust is an ordinary HTTP request with no origin to object to.
//
// REST v2 rather than v3, deliberately. v3 returns a description as Atlassian Document Format —
// a JSON tree of nested content nodes — and rendering that means walking it. v2 is not
// deprecated on Cloud and returns the same field as text, which is what a list needs.
//
// The endpoint is /search/jql, not /search. Atlassian removed the old one over the second half
// of 2025 and it now answers 410 Gone — a status that says nothing about what to do, which is
// why errorFor names the replacement rather than printing the number.
import { configRead, configWrite, httpSend } from "../shim/bridge.js";

const CFG = "plugin-jira";

export interface JiraSettings {
  /** The site host, e.g. "yourteam.atlassian.net". Stored without a scheme. */
  site: string;
  /** The Atlassian account email. Half of the credential — Cloud basic auth is email:token. */
  email: string;
  /** An API token from id.atlassian.com. Never synced: plugin- config is device-local. */
  token: string;
  /** JQL for the list. Defaults to the current sprint's tickets assigned to you. */
  jql: string;
}

export const DEFAULT_JQL = "assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC";

export const DEFAULTS: JiraSettings = { site: "", email: "", token: "", jql: DEFAULT_JQL };

let settings: JiraSettings = { ...DEFAULTS };
let loaded = false;

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((f) => f()); };

export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const getVersion = () => version;
export const get = () => settings;
/** All three are needed — any one missing and there is nothing to call. */
export const configured = () => Boolean(settings.site && settings.email && settings.token);

export async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const t = await configRead(CFG);
    if (t.trim()) {
      // Field by field rather than a blind spread: a hand-edited file should not put a number
      // where a string belongs and fail somewhere far from the cause.
      const raw = JSON.parse(t) as Partial<JiraSettings>;
      settings = {
        site: typeof raw.site === "string" ? raw.site : DEFAULTS.site,
        email: typeof raw.email === "string" ? raw.email : DEFAULTS.email,
        token: typeof raw.token === "string" ? raw.token : DEFAULTS.token,
        jql: typeof raw.jql === "string" && raw.jql.trim() ? raw.jql : DEFAULTS.jql,
      };
    }
  } catch { /* a corrupt file is not worth failing the tab for */ }
  emit();
}

export async function update(patch: Partial<JiraSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  emit();
  await configWrite(CFG, JSON.stringify(settings, null, 2)).catch(() => {});
}

// ---- the API ----------------------------------------------------------------------------

/** One ticket, flattened to what a list actually shows. */
export interface Issue {
  key: string;
  title: string;
  status: string;
  /**
   * Which column the ticket belongs in: "todo" | "doing" | "done".
   *
   * From Jira's own statusCategory rather than the status NAME. A project renames statuses
   * freely — "Ready for QA", "Blocked", "In Review" — but every one of them is filed under one
   * of three categories, and that mapping is the board's, maintained by whoever set the project
   * up. Guessing from the name would be wrong the first time someone invented a status.
   */
  category: "todo" | "doing" | "done";
  /** "" when nobody is assigned — Jira sends null, which would render as the word. */
  assignee: string;
  priority: string;
  /** Milliseconds, for "updated 2h ago". 0 when Jira sent nothing parseable. */
  updated: number;
  /** The browse link, built from the site rather than taken from the API's `self` (an API URL). */
  url: string;
}

/**
 * Strip a site to its host.
 *
 * People paste what is in the address bar, which is a URL with a scheme and usually a path.
 * Taken literally that produces `https://https://site/rest/...`, which fails as a DNS error and
 * sends someone looking at their network rather than at the box they filled in.
 */
export function siteHost(raw: string): string {
  return raw.trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

/** The Authorization header value for Cloud basic auth: base64 of "email:token". */
export function authHeader(email: string, token: string): string {
  // btoa is latin1-only and an email can hold non-ASCII, which throws rather than encoding.
  // TextEncoder gives the UTF-8 bytes, which is what the header is defined over.
  const bytes = new TextEncoder().encode(`${email.trim()}:${token.trim()}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** What a failed request should say, given its status. */
export function errorFor(status: number, body: string): string {
  // Jira answers a bad credential with 401 and a bad JQL with 400, and the difference is the
  // whole diagnosis — one is the settings panel, the other is the query box.
  if (status === 401) return "401 — the email or API token is wrong, or the token was revoked.";
  if (status === 403) return "403 — that account cannot read this project.";
  if (status === 404) return "404 — no Jira at that site. Check the host in settings.";
  // The old /search was removed over the second half of 2025. If this is ever seen again it
  // means another endpoint went the same way, and "410" alone sends nobody anywhere useful.
  if (status === 410) {
    return "410 — Jira removed this endpoint. Deck is calling /rest/api/2/search/jql; if that is "
      + "what returned this, the API has moved again and the plugin needs updating.";
  }
  if (status === 400) {
    // Jira puts the reason in errorMessages, which is far more useful than "400".
    try {
      const msgs = JSON.parse(body)?.errorMessages;
      if (Array.isArray(msgs) && msgs.length) return `Jira rejected the query: ${msgs.join(" ")}`;
    } catch { /* fall through to the plain status */ }
    return "400 — Jira rejected the request. The JQL is the usual reason.";
  }
  return `Jira returned ${status}.`;
}

/**
 * Jira's status category key, as a column.
 *
 * The API's keys are "new", "indeterminate" and "done", which are not words anyone would put on
 * a column. Anything unrecognised goes to "todo": a ticket in no column at all is worse than one
 * in the leftmost.
 */
export function toCategory(key: unknown): Issue["category"] {
  if (key === "done") return "done";
  if (key === "indeterminate") return "doing";
  return "todo";
}

/** Flatten one issue from the API's nested fields. Exported for the check. */
export function toIssue(raw: any, host: string): Issue {
  const f = raw?.fields ?? {};
  const t = Date.parse(f.updated ?? "");
  return {
    key: String(raw?.key ?? ""),
    title: String(f.summary ?? ""),
    status: String(f.status?.name ?? ""),
    // Nested inside `status`, so it costs nothing extra to ask for.
    category: toCategory(f.status?.statusCategory?.key),
    // Jira sends null for each of these when unset, and String(null) is "null" on the screen.
    assignee: f.assignee?.displayName ? String(f.assignee.displayName) : "",
    priority: f.priority?.name ? String(f.priority.name) : "",
    updated: Number.isNaN(t) ? 0 : t,
    url: `https://${host}/browse/${raw?.key ?? ""}`,
  };
}

/**
 * The columns a set of issues implies, in the order work moves through them.
 *
 * Built from the tickets rather than fetched. Jira's three status CATEGORIES are too coarse —
 * a real board separates Code Review, To Deploy and Blocked, and all three are "indeterminate"
 * — while the board's actual column order lives on the board, not in the issue data, and
 * asking for it is another call that can still disagree with what came back.
 *
 * So: one column per status present, sorted by category (To Do, then In Progress, then Done)
 * and within a category by first appearance, which is the order Jira returned them in. The
 * result matches a real board closely without claiming to BE it, and a status with no tickets
 * simply has no column — there is nothing in the response to know it exists.
 */
export function columnsFor(issues: readonly Issue[]): { status: string; category: Issue["category"] }[] {
  const rank: Record<Issue["category"], number> = { todo: 0, doing: 1, done: 2 };
  const seen = new Map<string, { status: string; category: Issue["category"]; at: number }>();
  issues.forEach((i, at) => {
    const key = i.status || "(no status)";
    if (!seen.has(key)) seen.set(key, { status: key, category: i.category, at });
  });
  return [...seen.values()]
    .sort((a, b) => rank[a.category] - rank[b.category] || a.at - b.at)
    .map(({ status, category }) => ({ status, category }));
}

/** Run the configured JQL and return the issues. Throws with a readable reason. */
export async function search(): Promise<Issue[]> {
  const { email, token, jql } = settings;
  const host = siteHost(settings.site);
  if (!host || !email || !token) throw new Error("not configured — see Settings › Plugins › Jira");

  const params = new URLSearchParams({
    jql: jql.trim() || DEFAULT_JQL,
    maxResults: "50",
    // Only what the list renders. Asking for everything makes each issue several KB of fields
    // nothing reads.
    fields: "summary,status,assignee,priority,updated",
  });
  const r = await httpSend({
    method: "GET",
    url: `https://${host}/rest/api/2/search/jql?${params}`,
    headers: [["Authorization", authHeader(email, token)], ["Accept", "application/json"]],
  });
  if (r.status < 200 || r.status >= 300) throw new Error(errorFor(r.status, r.body));

  const data = JSON.parse(r.body);
  const list = Array.isArray(data?.issues) ? data.issues : [];
  return list.map((i: unknown) => toIssue(i, host));
}
