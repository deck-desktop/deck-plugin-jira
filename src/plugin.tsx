// Jira — the tickets assigned to you, in a tab.
//
// A list and a link, on purpose. Deck is not where the work on a ticket happens; it is where
// you find out what the ticket is and go to it. Transitions and comments are what Jira's own
// UI does well, and duplicating them here would mean keeping up with workflows Deck cannot see.
import { useEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw, ExternalLink, AlertTriangle, Search } from "lucide-react";
import { openExternal } from "../shim/bridge.js";
import { Field, TextInput } from "../shim/ui.js";
import {
  DEFAULT_JQL, columnsFor, configured, get, getVersion, load, search, subscribe, update,
  type Issue,
} from "./api";

void load();

/** Relative time, to the minute. A ticket updated three weeks ago does not need the hour. */
function ago(ms: number): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** A column's dot colour, from its status category. */
const CATEGORY_COLOR: Record<Issue["category"], string> = {
  todo: "var(--text-muted)",
  doing: "var(--accent)",
  done: "#3fb950",
};

export default function Jira() {
  useSyncExternalStore(subscribe, getVersion);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const on = configured();

  const refresh = () => {
    if (!on) return;
    setBusy(true);
    search()
      .then((list) => { setIssues(list); setError(""); })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setBusy(false));
  };
  // On open, and again whenever the settings change — pasting a token should not need a
  // second click to prove it worked.
  useEffect(refresh, [on, get().site, get().email, get().token, get().jql]);

  const shown = (issues ?? []).filter((i) => {
    const q = filter.trim().toLowerCase();
    return !q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q);
  });
  // From every ticket, not the filtered set: typing in the box should empty a column, not
  // remove it — a board whose columns come and go as you type is impossible to read.
  const columns = columnsFor(issues ?? []);

  if (!on) {
    return (
      <div className="grid h-full w-full place-items-center p-8 text-center">
        <div className="max-w-md space-y-2">
          <h2 className="text-lg font-semibold text-text-primary">Jira is not connected</h2>
          <p className="text-sm text-text-secondary">
            Settings › Plugins › Jira takes your site, the email on your Atlassian account, and an
            API token. Nothing is sent anywhere but your own Jira.
          </p>
        </div>
      </div>
    );
  }

  // No max-width: columns of cards use whatever the window gives them, and capping it left the
  // board floating in the middle with empty space either side.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="mb-4 flex shrink-0 items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Jira</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {issues === null ? "Loading…"
              : `${issues.length} ${issues.length === 1 ? "ticket" : "tickets"}`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter"
              className="h-9 w-44 rounded-md border border-strong bg-elev pl-8 pr-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition focus:border-accent" />
          </div>
          <button onClick={refresh} disabled={busy} title="Refresh"
            className="flex h-9 items-center gap-1.5 rounded-md border border-subtle px-3 text-[12px] text-text-muted transition hover:text-text-primary disabled:opacity-50">
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-[12px]"
          style={{ borderColor: "var(--border-strong)", background: "var(--bg-card)", color: "var(--text-secondary)" }}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: "var(--danger)" }} />
          {error}
        </div>
      )}

      {issues !== null && shown.length === 0 && !error && (
        <p className="px-1 py-6 text-center text-sm text-text-muted">
          {filter ? "Nothing matches that filter." : "No tickets came back for this query."}
        </p>
      )}

      {/* One column per status, all of them on screen — an equal share of the width rather
          than a fixed size that scrolls. minmax(0, 1fr) rather than plain 1fr: a grid track
          defaults to min-content, so without the 0 a long unbroken title sets the column's
          width and the whole board overflows anyway. */}
      <div className="grid min-h-0 flex-1 gap-3"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` }}>
        {columns.map((col) => {
          const cards = shown.filter((i) => (i.status || "(no status)") === col.status);
          return (
            <div key={col.status} className="flex min-h-0 min-w-0 flex-col rounded-xl border border-subtle"
              style={{ background: "var(--bg-card-glass)" }}>
              <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[col.category] }} />
                <span className="truncate text-[12px] font-semibold uppercase tracking-wide text-text-secondary">{col.status}</span>
                <span className="ml-auto text-[11px] tabular-nums text-text-muted">{cards.length}</span>
              </div>
              <div className="scroll-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
                {cards.map((i) => (
                  // The whole card opens the ticket: everything on it is about one issue, and a
                  // link behind a small icon is a target to aim at for no reason.
                  <button key={i.key} onClick={() => void openExternal(i.url)}
                    title={`${i.status}${i.assignee ? ` · ${i.assignee}` : ""}\n\nOpen ${i.key} in your browser`}
                    className="group w-full rounded-lg border border-subtle px-2.5 py-2 text-left transition-colors hover:border-accent-soft"
                    style={{ background: "var(--bg-elev)" }}>
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[11px] text-text-secondary">{i.key}</span>
                      <ExternalLink size={10} className="ml-auto shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    {/* Two lines, then clipped. A card sized to its title makes every row in the
                        column a different height and the board impossible to scan. */}
                    <div className="mt-1 line-clamp-3 break-words text-[13px] leading-snug text-text-primary">{i.title}</div>
                    <div className="mt-1.5 flex items-center gap-2 text-[10px] text-text-muted">
                      {/* Not the status — that is the column heading now. The assignee is what a
                          shared query makes worth showing, and is blank on a personal one. */}
                      <span className="truncate">{i.assignee}</span>
                      <span className="ml-auto shrink-0 tabular-nums">{ago(i.updated)}</span>
                    </div>
                  </button>
                ))}
                {cards.length === 0 && (
                  <p className="px-1 py-4 text-center text-[11px] text-text-muted">Nothing here.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Command-palette entries. */
export function commands() {
  return [
    { id: "open", title: "Jira: open the ticket list", run: () => {
      window.dispatchEvent(new CustomEvent("deck-navigate", { detail: "jira" }));
    } },
  ];
}

/** The settings panel, in Settings › Plugins › Jira. */
export function Settings() {
  useSyncExternalStore(subscribe, getVersion);
  const s = get();

  return (
    <div className="space-y-3">
      <Field label="Site" hint="Your Jira host, e.g. yourteam.atlassian.net. A pasted URL is fine — the scheme and path are ignored.">
        <TextInput value={s.site} onChange={(e) => void update({ site: e.target.value })}
          placeholder="yourteam.atlassian.net" />
      </Field>

      <Field label="Email" hint="The address on your Atlassian account. Cloud pairs it with the token — the token alone will not authenticate.">
        <TextInput value={s.email} onChange={(e) => void update({ email: e.target.value.trim() })}
          placeholder="you@example.com" />
      </Field>

      <Field label="API token" hint="From id.atlassian.com › Security › API tokens. Stored on this machine only — a plugin's config is never synced.">
        <TextInput type="password" value={s.token}
          onChange={(e) => void update({ token: e.target.value.trim() })}
          placeholder="paste the token" />
      </Field>

      <Field label="Query" hint="JQL for the list. The default is your tickets in an open sprint.">
        <TextInput value={s.jql} onChange={(e) => void update({ jql: e.target.value })}
          placeholder={DEFAULT_JQL} />
      </Field>

      {s.jql.trim() && s.jql.trim() !== DEFAULT_JQL && (
        <button onClick={() => void update({ jql: DEFAULT_JQL })}
          className="rounded-md border border-subtle bg-elev px-3 py-1.5 text-[12px] text-text-secondary transition hover:text-text-primary">
          Reset the query
        </button>
      )}
    </div>
  );
}
