export type ActionItem = {
  id: string
  text: string
  session: string
  createdAt: string
  doneAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    actions: { items: Shaped<ActionItem[]> }
  }
}
