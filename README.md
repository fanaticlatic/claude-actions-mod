# Actions

A checklist pane beside the chat, listing the things Claude has asked you to do yourself, shared by every Claude Code session on this computer.

## What it does

- When Claude asks you to run a command, click something or power a machine on, it calls the `add` tool and the item appears in the Actions pane, tagged with the session that asked.
- When you tell Claude an item is done, it calls the `done` tool and the item is ticked.
- You can tick or untick any item yourself by clicking its row in the pane. Claude sees that through the `list` tool.
- Ticked items drop off after 24 hours, or at once with `/actions clear`. `/actions` reopens the pane if you closed it.

## Where the list lives

In this plugin's own store, a JSON file under your Claude Code configuration folder. Every session reads and writes the same file, and each session re-reads it every few seconds, so a change made in one session shows in the others.

## Loading it in every session

While the mod is in a session's dev-mods folder it loads only in that session. To have it in every session on this machine, either name the folder in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, or add the folder as a marketplace from a terminal (`claude plugin marketplace add <folder>`) and install it at user scope.

## Tools the model sees

- `mcp__actions__add` `{ items: string[] }`
- `mcp__actions__done` `{ ids?: string[], texts?: string[], reopen?: boolean }`
- `mcp__actions__list` `{}`

## Install

At the prompt of a terminal session:

```
/plugin install actions --marketplace fanaticlatic/claude-actions-mod
```

From a shell:

```
claude plugin install actions --marketplace fanaticlatic/claude-actions-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `fanaticlatic/claude-actions-mod`, then Add plugin.

## Notes

- The list is stored per machine, in the plugin's own store under the Claude Code configuration folder. Installing on two machines gives two separate lists.
- A plugin tool's `tool.call` answer is `{ result: string }` or `{ deny: text }`; the store is one whole-file write per session, so `write()` re-reads and re-applies until its change sticks.
