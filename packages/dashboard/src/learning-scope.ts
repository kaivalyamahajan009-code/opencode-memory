/** GET /api/learning has no all-workspaces mode; without a workspace the server uses this one. */
export const DEFAULT_LEARNING_WORKSPACE = "personal-knowledge"

/** The workspace every learning query (concepts and misconceptions alike) uses for the sidebar selection. */
export function learningWorkspace(selected: string): { workspace: string; fallback: boolean } {
  const ws = selected.trim()
  return ws ? { workspace: ws, fallback: false } : { workspace: DEFAULT_LEARNING_WORKSPACE, fallback: true }
}
