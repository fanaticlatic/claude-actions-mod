import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActionItem } from '../types'

const PANE = 'actions'
const STORE_KEY = 'items'
const DONE_TTL_MS = 24 * 60 * 60 * 1000
const SYNC_MS = 5000

// Bump the tag when ActionItem's fields change: an older stored value is
// then read as `[]` rather than drawn with missing fields.
const items = atom({ plugin: 'actions', key: 'items' } as const, [], {
  shape: 'items-1',
})

let sessionLabel = 'session'

function isItem(x: unknown): x is ActionItem {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.text === 'string' &&
    typeof o.session === 'string' &&
    typeof o.createdAt === 'string' &&
    (o.doneAt === null || typeof o.doneAt === 'string')
  )
}

function prune(list: ActionItem[], now: number): ActionItem[] {
  return list.filter(
    it => it.doneAt === null || now - Date.parse(it.doneAt) < DONE_TTL_MS,
  )
}

function newId(): string {
  return Math.random().toString(36).slice(2, 8)
}

async function loadStore($: EngineInterface): Promise<ActionItem[]> {
  const raw = await $.store.get(STORE_KEY)
  const list = Array.isArray(raw) ? raw.filter(isItem) : []
  const kept = prune(list, await $.clock.now())
  // Pruned or malformed rows leave the file too, not just the drawing.
  if (kept.length !== (Array.isArray(raw) ? raw.length : 0)) {
    await $.store.set(STORE_KEY, kept)
  }
  return kept
}

// Every write lands in both places: the atom redraws the pane, the store
// outlives the session and is what other sessions read.
//
// The store is one file shared by every session, written whole, so two
// sessions writing at once can overwrite each other (seen in a 4-process
// test: 2 of 40 adds lost). `fn` must therefore be idempotent, and after
// each write the file is read back: if applying `fn` again would change it,
// our change was lost and is re-applied on top of whatever landed.
const WRITE_TRIES = 6

async function write(
  $: EngineInterface,
  fn: (list: ActionItem[]) => ActionItem[],
): Promise<ActionItem[]> {
  let next: ActionItem[] = []
  for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
    const current = await loadStore($)
    next = fn(current)
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await $.store.set(STORE_KEY, next)
    }
    const landed = await loadStore($)
    if (JSON.stringify(fn(landed)) === JSON.stringify(landed)) {
      next = landed
      break
    }
    await $.clock.sleep(20 + Math.floor(Math.random() * 60))
  }
  await update($, items, () => next)
  return next
}

// What a tool call returns to the model. Open items are always listed;
// ticked ones only when `full` (the list tool), newest first and capped, so
// an add or done reply stays small however many ticked rows await expiry.
const TICKED_SHOWN = 10

function describe(list: ActionItem[], full = false): string {
  if (list.length === 0) return 'No actions on the list.'
  const open = list.filter(it => it.doneAt === null)
  const done = list
    .filter(it => it.doneAt !== null)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
  const line = (it: ActionItem) =>
    `- ${it.doneAt === null ? '[ ]' : '[x]'} ${it.id}: ${it.text} (from: ${it.session})`
  const out = [`${open.length} open, ${done.length} done.`, ...open.map(line)]
  if (full && done.length > 0) {
    out.push(...done.slice(0, TICKED_SHOWN).map(line))
    if (done.length > TICKED_SHOWN) out.push(`… ${done.length - TICKED_SHOWN} more ticked`)
  } else if (done.length > 0) {
    out.push('(ticked items omitted; call list to see them)')
  }
  return out.join('\n')
}

function asStrings(x: unknown): string[] {
  if (typeof x === 'string') return [x]
  if (Array.isArray(x)) return x.filter((s): s is string => typeof s === 'string')
  return []
}

// A plugin tool's result is a string (or content blocks); a failure is a deny.
function textResult(text: string, isError = false) {
  return isError ? { deny: text } : { result: text }
}

const SECTION = `# Actions checklist

The user keeps an "Actions" pane beside the chat: a checklist of things you asked them to do themselves, shared across all of their sessions. Three tools serve it: mcp__actions__add, mcp__actions__done, mcp__actions__list.

- Whenever you ask the user to do something themselves (run a command, click something, power a machine on, answer something outside this chat), call mcp__actions__add in the same turn with one short imperative line per action. Never add work you do yourself.
- When the user's reply plainly says an action is done, call mcp__actions__done for it (by id from a list, or by a distinctive substring of its text). If the reply is ambiguous, leave it open and say so.
- When the user may be reporting on earlier actions, or asks what is still outstanding, call mcp__actions__list first: the user can also tick items by clicking the pane, and only the list shows that.
- The slash command /actions opens the pane; /actions clear removes ticked items.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const cwd = (await $.session.cwd()).replace(/[\\/]+$/, '')
    const base = cwd.split(/[\\/]/).pop() || cwd
    sessionLabel = `${base} ${(await $.session.id()).slice(0, 6)}`

    const list = await loadStore($)
    await update($, items, () => list)

    await $.command.register({
      name: 'actions',
      description: 'Open the Actions pane; "/actions clear" removes ticked items',
      argumentHint: '[clear]',
    })

    await $.tool.register({
      name: 'add',
      description:
        'Add actions the user must perform themselves to their shared Actions checklist. One short imperative line per action. Returns the new ids.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'One line per action, imperative, as asked of the user',
          },
        },
        required: ['items'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'done',
      description:
        'Tick actions on the shared Actions checklist once the user says they did them. Match by id (from list) or by a distinctive substring of the text.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          texts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Case-insensitive substrings of the actions to tick',
          },
          reopen: {
            type: 'boolean',
            description: 'Untick instead of tick (the user says it is not done after all)',
          },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list',
      description:
        'List the shared Actions checklist: open items first, then ticked ones, with ids and which session asked.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    void $.ui.open({ id: PANE, title: 'Actions' })

    // Another session's writes reach this one through the store file.
    $.clock.every(SYNC_MS, async () => {
      const fresh = await loadStore($)
      const shown = await read($, items)
      if (JSON.stringify(fresh) !== JSON.stringify(shown)) {
        await update($, items, () => fresh)
      }
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__actions__add' }, async ($, e) => {
    const texts = asStrings((e as Record<string, unknown>).items)
      .map(s => s.trim())
      .filter(Boolean)
    if (texts.length === 0) return textResult('Nothing to add: items is empty.', true)
    const now = new Date(await $.clock.now()).toISOString()
    const added: ActionItem[] = texts.map(text => ({
      id: newId(),
      text,
      session: sessionLabel,
      createdAt: now,
      doneAt: null,
    }))
    const list = await write($, cur => {
      const have = new Set(cur.map(it => it.id))
      return [...cur, ...added.filter(it => !have.has(it.id))]
    })
    return textResult(
      `Added ${added.map(it => `${it.id}: ${it.text}`).join('; ')}.\n${describe(list)}`,
    )
  }).catch((_$, _e) => textResult('The Actions store could not be written.', true))

  on('tool.call', { tool: 'mcp__actions__done' }, async ($, e) => {
    const input = e as Record<string, unknown>
    const ids = new Set(asStrings(input.ids))
    const texts = asStrings(input.texts).map(s => s.toLowerCase()).filter(Boolean)
    const reopen = input.reopen === true
    if (ids.size === 0 && texts.length === 0) {
      return textResult('Give ids or texts to match.', true)
    }
    const now = new Date(await $.clock.now()).toISOString()
    // Keyed by id: `write` may apply the transform more than once.
    const changedById = new Map<string, ActionItem>()
    const list = await write($, cur =>
      cur.map(it => {
        const hit =
          ids.has(it.id) || texts.some(t => it.text.toLowerCase().includes(t))
        if (!hit) return it
        const want = reopen ? null : now
        if ((it.doneAt === null) === (want === null)) return it
        const out = { ...it, doneAt: want }
        changedById.set(out.id, out)
        return out
      }),
    )
    const changed = [...changedById.values()]
    const verb = reopen ? 'Reopened' : 'Ticked'
    const head =
      changed.length === 0
        ? 'Nothing matched (or it was already in that state).'
        : `${verb} ${changed.map(it => `${it.id}: ${it.text}`).join('; ')}.`
    return textResult(`${head}\n${describe(list)}`, changed.length === 0)
  }).catch((_$, _e) => textResult('The Actions store could not be written.', true))

  on('tool.call', { tool: 'mcp__actions__list' }, async $ => {
    const list = await loadStore($)
    await update($, items, () => list)
    return textResult(describe(list, true))
  }).catch((_$, _e) => textResult('The Actions store could not be read.', true))

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return {
      sections: [
        ...sections,
        { id: 'actions:checklist', text: SECTION, scope: 'session' as const },
      ],
    }
  })

  on('command.run', { command: 'actions' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'clear') {
      const before = await loadStore($)
      const list = await write($, cur => cur.filter(it => it.doneAt === null))
      return { text: `Cleared ${before.length - list.length} ticked action(s).` }
    }
    await $.ui.open({ id: PANE, title: 'Actions' })
    return { text: 'Actions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, items)
    // Open rows oldest first (the order they were asked); ticked rows newest
    // first, so what was just ticked stays in view under the open ones.
    const open = list.filter(it => it.doneAt === null)
    const done = list
      .filter(it => it.doneAt !== null)
      .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
    const rows = [...open, ...done]
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 4)

    // The target state is decided once, from what the row showed when it was
    // pressed, so a retried write never flips it back.
    const toggle = (id: string, wasDone: boolean) => async () => {
      const want = wasDone ? null : new Date(await $.clock.now()).toISOString()
      await write($, cur =>
        cur.map(it => (it.id === id && it.doneAt !== want ? { ...it, doneAt: want } : it)),
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {open.length} open
          {done.length > 0 ? ` · ${done.length} done` : ''}
        </Text>
        {rows.length === 0 && <Text dimColor>No open actions.</Text>}
        {rows.slice(0, room).map(it => (
          <Button
            key={it.id}
            plain
            dimColor={it.doneAt !== null}
            onPress={toggle(it.id, it.doneAt !== null)}
          >
            {it.doneAt === null ? '[ ] ' : '[x] '}
            {it.text} <Text dimColor>({it.session})</Text>
          </Button>
        ))}
        {rows.length > room && <Text dimColor>… {rows.length - room} more</Text>}
        {done.length > 0 && (
          <Button
            key="clear"
            onPress={() => write($, cur => cur.filter(it => it.doneAt === null))}
          >
            Clear ticked
          </Button>
        )}
      </Box>
    )
  })
}
