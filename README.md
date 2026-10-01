# Jira

The tickets assigned to you, read straight from Jira with an API token.

Issues are grouped by status category and open in the browser. The JQL is yours to change, so
"assigned to me and not done" is the default rather than the only thing it can show.

## The token

Created at *id.atlassian.com -> Security -> API tokens* and typed into Deck's settings for this
plugin. It is stored under the `plugin-` config prefix, which keeps it on this machine and out of
any sync. Nothing is written back to Jira - this plugin only reads.

## What it exports

| Export | Where it renders |
|---|---|
| `default` | the tab: your issues, grouped by status |
| `Settings` | site, email, token and the JQL |
| `commands` | palette entry to open it |

## Checks

```sh
node plugins/jira/jira.check.mjs
```

Site and auth header derivation, error parsing, and flattening an issue into the shape the table
renders.

## Build

```sh
node plugins/jira/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js` into `%APPDATA%\Deck\plugins\jira\` (`Deck-Dev` for a
debug build) and restart Deck.
