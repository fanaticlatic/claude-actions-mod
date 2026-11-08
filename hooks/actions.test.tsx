import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'actions',
  component: 'Pane',
  requestId: 'actions',
  props: {
    title: 'Actions',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const T0 = Date.parse('2026-11-08T10:00:00Z')

type Item = {
  id: string
  text: string
  session: string
  createdAt: string
  doneAt: string | null
}

const seed: Item[] = [
  {
    id: 'aaa111',
    text: 'Run: git push local main',
    session: 'myapp 123456',
    createdAt: new Date(T0 - 60_000).toISOString(),
    doneAt: null,
  },
  {
    id: 'bbb222',
    text: 'Restart the dev server',
    session: 'myapp 123456',
    createdAt: new Date(T0 - 60_000).toISOString(),
    doneAt: new Date(T0 - 30_000).toISOString(),
  },
  {
    id: 'ccc333',
    text: 'Stale ticked item from two days ago',
    session: 'old 000000',
    createdAt: new Date(T0 - 3 * 86_400_000).toISOString(),
    doneAt: new Date(T0 - 2 * 86_400_000).toISOString(),
  },
]

// Nothing sits beneath the plugin: these hooks stand for the engine. The
// store is a plain object the test can read back.
function stand(on: On, initial: Item[]) {
  const mem: Record<string, unknown> = { items: initial }
  on('command.register', () => ({ value: { command: 'actions' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__actions__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'deadbeef-0000' }))
  on('session.cwd', () => ({ value: 'C:\\work\\myapp' }))
  on('store.get', (_, e) => ({ value: mem[e.key] }))
  on('store.set', (_, e) => {
    mem[e.key] = e.value
    return { value: undefined }
  })
  return { items: () => (mem.items as Item[]) ?? [] }
}

const START = { cwd: 'C:\\work\\myapp', surface: 'desktop', isInteractive: true } as const

test('seeded items draw, stale ticked ones are pruned', async ($, on) => {
  const store = stand(on, seed)
  mock.clock(on, { now: T0 })
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'aaa111' })).toBeDefined()
    expect(await ui.find({ key: 'bbb222' })).toBeDefined()
    expect(await ui.find({ key: 'ccc333' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /open/ }))?.text).toBe('1 open · 1 done')
    await ui.unmount()
  }
  expect(store.items().map(it => it.id)).toEqual(['aaa111', 'bbb222'])
})

test('add and done tools change the list and the store', async ($, on) => {
  const store = stand(on, [])
  mock.clock(on, { now: T0 })
  await $.session.start(START)

  const added = await $.tool.call({
    tool: 'mcp__actions__add',
    items: ['Power on box 2', 'Run the smoke test'],
  })
  expect('deny' in added && added.deny).toBeFalsy()

  expect(store.items().length).toBe(2)
  expect(store.items()[0]?.session).toBe('myapp deadbe')
  expect(store.items()[0]?.doneAt).toBeNull()

  await $.tool.call({ tool: 'mcp__actions__done', texts: ['box 2'] })
  expect(store.items().find(it => it.text === 'Power on box 2')?.doneAt).toBe(
    new Date(T0).toISOString(),
  )
  expect(store.items().find(it => it.text === 'Run the smoke test')?.doneAt).toBeNull()

  const listed = await $.tool.call({ tool: 'mcp__actions__list' })
  expect(JSON.stringify(listed)).toContain("1 open, 1 done")

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  await ui.unmount()
})

test('a click toggles an item and /actions clear drops ticked ones', async ($, on) => {
  const store = stand(on, seed.slice(0, 2))
  mock.clock(on, { now: T0 })
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'aaa111' })
    expect(store.items().find(it => it.id === 'aaa111')?.doneAt).not.toBeNull()
    await ui.press({ key: 'aaa111' })
    expect(store.items().find(it => it.id === 'aaa111')?.doneAt).toBeNull()
    await ui.unmount()
  }

  const out = await $.command.run({
    command: 'actions',
    args: 'clear',
    origin: { kind: 'plugin', name: 'test' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(out.text).toBe('Cleared 1 ticked action(s).')
  expect(store.items().map(it => it.id)).toEqual(['aaa111'])
})

test("another session's write shows up on the next sync tick", async ($, on) => {
  const store = stand(on, [])
  const clock = mock.clock(on, { now: T0 })
  await $.session.start(START)

  // Simulate another session writing the shared file.
  store.items().push(seed[0]!)
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'aaa111' })).toBeDefined()
  await ui.unmount()
})

test('a write another session overwrote is re-applied', async ($, on) => {
  // The store beneath drops the first set (another session's whole-file
  // write landing on top of ours) and keeps the ones after it.
  let mem: Item[] = [seed[0]!]
  let sets = 0
  on('command.register', () => ({ value: { command: 'actions' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__actions__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'deadbeef-0000' }))
  on('session.cwd', () => ({ value: 'C:\\work\\myapp' }))
  on('store.get', () => ({ value: mem }))
  on('store.set', (_, e) => {
    sets++
    if (sets === 1) mem = [seed[0]!, seed[1]!] // someone else's list won
    else mem = e.value as Item[]
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: T0 })
  await $.session.start(START)

  const call = $.tool.call({ tool: 'mcp__actions__add', items: ['Survives a clobber'] })
  await clock.advance(1000)
  await call

  expect(sets).toBe(2)
  expect(mem.map(it => it.text)).toEqual([
    'Run: git push local main',
    'Restart the dev server',
    'Survives a clobber',
  ])
})
