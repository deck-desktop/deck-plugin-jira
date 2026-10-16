// The pure parts of talking to Jira: the site string, the auth header, what an error means,
// and flattening an issue.
//
//   node jira.check.mjs
//
// Each of these fails quietly. A site with the scheme left on produces `https://https://…`,
// which reads as a network fault; a null assignee renders the word "null" in the list; and the
// difference between a 401 and a 400 is the difference between the token box and the query box.
import assert from "node:assert";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The real source, compiled — not a copy. A check with its own copy of the logic cannot fail
// when the source changes, which is the one thing it exists to catch.
const out = await build({
  entryPoints: [join(here, "src/api.ts")],
  bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{
    name: "shim",
    setup(b) {
      b.onResolve({ filter: /shim\/bridge\.js$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export const configRead = async () => '';" +
                  "export const configWrite = async () => {};" +
                  "export const httpSend = async () => ({});",
        loader: "js",
      }));
    },
  }],
});
const { siteHost, authHeader, errorFor, toIssue, toCategory, columnsFor } = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);

// ---- siteHost: people paste whatever is in the address bar ---------------------------------
assert.equal(siteHost("team.atlassian.net"), "team.atlassian.net");
assert.equal(siteHost("https://team.atlassian.net"), "team.atlassian.net");
assert.equal(siteHost("https://team.atlassian.net/"), "team.atlassian.net");
// The most likely paste of all: a link to a board, or to the ticket they were looking at.
assert.equal(siteHost("https://team.atlassian.net/jira/software/projects/ABC/boards/1"), "team.atlassian.net");
assert.equal(siteHost("https://team.atlassian.net/browse/ABC-123"), "team.atlassian.net");
assert.equal(siteHost("  HTTPS://Team.Atlassian.NET/  "), "team.atlassian.net");
assert.equal(siteHost(""), "");

// ---- authHeader: base64 of email:token, over UTF-8 ------------------------------------------
assert.equal(authHeader("a@b.c", "tok"), `Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
// Whitespace around a pasted token is invisible and would otherwise be signed into the header.
assert.equal(authHeader(" a@b.c ", " tok "), authHeader("a@b.c", "tok"));
// A non-ASCII address: btoa alone throws on these rather than encoding them, which is why the
// bytes go through TextEncoder first.
assert.equal(authHeader("tomás@b.c", "tok"), `Basic ${Buffer.from("tomás@b.c:tok", "utf8").toString("base64")}`);

// ---- errorFor: the status is the diagnosis --------------------------------------------------
assert.match(errorFor(401, ""), /token/i);
assert.match(errorFor(403, ""), /cannot read/i);
assert.match(errorFor(404, ""), /site/i);
// A 400 is nearly always the JQL, and Jira says why in errorMessages — far better than "400".
assert.match(
  errorFor(400, JSON.stringify({ errorMessages: ["Field 'sprint' does not exist."] })),
  /Field 'sprint' does not exist\./,
);
// A body that is not JSON must not throw on the way to reporting an error.
assert.match(errorFor(400, "<html>gateway</html>"), /400/);
assert.match(errorFor(500, ""), /500/);

// ---- toIssue: Jira sends null for anything unset --------------------------------------------
const raw = {
  key: "ABC-1",
  fields: {
    summary: "Fix the thing",
    status: { name: "In Progress" },
    assignee: { displayName: "Hasan" },
    priority: { name: "High" },
    updated: "2026-09-19T10:00:00.000+0000",
  },
};
const i = toIssue(raw, "team.atlassian.net");
assert.equal(i.key, "ABC-1");
assert.equal(i.title, "Fix the thing");
assert.equal(i.status, "In Progress");
assert.equal(i.assignee, "Hasan");
assert.equal(i.url, "https://team.atlassian.net/browse/ABC-1");
assert.ok(i.updated > 0, "updated should parse to millis");

// Unassigned, no priority: Jira sends null, and String(null) puts "null" on the screen.
const bare = toIssue({ key: "ABC-2", fields: { summary: "x", status: { name: "To Do" }, assignee: null, priority: null } }, "h");
assert.equal(bare.assignee, "");
assert.equal(bare.priority, "");
assert.equal(bare.updated, 0, "a missing date is 0, not NaN");

// A response shaped unlike the docs must not throw — it renders as an empty row instead.
const junk = toIssue({}, "h");
assert.equal(junk.key, "");
assert.equal(junk.title, "");

// ---- toCategory: which column a ticket lands in ---------------------------------------------
// From Jira's statusCategory, never the status NAME — a project renames statuses freely and
// every rename would otherwise need a new case here.
assert.equal(toCategory("new"), "todo");
assert.equal(toCategory("indeterminate"), "doing");
assert.equal(toCategory("done"), "done");
// Anything unrecognised goes left rather than vanishing: a ticket in no column is worse than a
// ticket in the wrong one, because nothing on screen says it exists.
assert.equal(toCategory("something-atlassian-added"), "todo");
assert.equal(toCategory(undefined), "todo");
assert.equal(toCategory(null), "todo");

// The category rides along inside `status`, so it costs no extra field on the request.
const inProgress = toIssue({
  key: "ABC-3",
  fields: { summary: "x", status: { name: "In Review", statusCategory: { key: "indeterminate" } } },
}, "h");
assert.equal(inProgress.category, "doing");
// "In Review" is not "In Progress", and the card shows both — the column from the category,
// the real status underneath it.
assert.equal(inProgress.status, "In Review");
// An issue with no statusCategory at all still lands somewhere.
assert.equal(toIssue({ key: "ABC-4", fields: { status: { name: "Odd" } } }, "h").category, "todo");

// ---- columnsFor: the board's columns, from the tickets ---------------------------------------
// Three status categories are too coarse for a real board — Code Review, To Deploy and Blocked
// are all "indeterminate" and would collapse into one column.
const iss = (status, category, key) => ({ key, title: "", status, category, assignee: "", priority: "", updated: 0, url: "" });

const board = columnsFor([
  iss("Done", "done", "A-1"),
  iss("CODE REVIEW", "doing", "A-2"),
  iss("To Do", "todo", "A-3"),
  iss("Blocked", "doing", "A-4"),
  iss("In Progress", "doing", "A-5"),
]);
// Category first — every To Do left of every In Progress, every Done last — and within a
// category the order Jira returned them, which is the closest thing to the board's own order
// that the issue data carries.
assert.deepEqual(board.map((c) => c.status),
  ["To Do", "CODE REVIEW", "Blocked", "In Progress", "Done"]);

// One column per status, however many tickets share it.
assert.equal(columnsFor([iss("To Do", "todo", "A"), iss("To Do", "todo", "B")]).length, 1);
// Nothing in, nothing out — the empty board renders its own message rather than a row of
// columns with nothing in them.
assert.deepEqual(columnsFor([]), []);
// A status Jira left blank still gets a column, rather than the tickets vanishing.
assert.deepEqual(columnsFor([iss("", "todo", "A")]).map((c) => c.status), ["(no status)"]);

console.log("jira.check.mjs: ok");
