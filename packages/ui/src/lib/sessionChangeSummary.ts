export type SessionChangeSummary = {
  additions?: number
  deletions?: number
  files?: number
}

const finiteCount = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const next = Math.trunc(value)
  return next >= 0 ? next : undefined
}

const readSummaryRecord = (session: unknown): Record<string, unknown> | null => {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const summary = (session as { summary?: unknown }).summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
  return summary as Record<string, unknown>
}

/** Read additions / deletions / files from an OpenCode session summary. No invented zeros. */
export function readSessionChangeSummary(session: unknown): SessionChangeSummary | null {
  const summary = readSummaryRecord(session)
  if (!summary) return null
  const additions = finiteCount(summary.additions)
  const deletions = finiteCount(summary.deletions)
  const files = finiteCount(summary.files) ?? finiteCount(summary.diffCount)
  if (additions === undefined && deletions === undefined && files === undefined) return null
  return {
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(files !== undefined ? { files } : {}),
  }
}

/** Compact `+12 −3` from actual counts only. */
export function formatSessionChangeCounts(summary: SessionChangeSummary | null): string | null {
  if (!summary) return null
  const parts: string[] = []
  if (summary.additions !== undefined) parts.push(`+${summary.additions}`)
  if (summary.deletions !== undefined) parts.push(`−${summary.deletions}`)
  return parts.length > 0 ? parts.join(' ') : null
}

export function readSessionModelLabel(session: unknown): string | null {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const record = session as Record<string, unknown>
  const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : ''
  const modelID = typeof record.modelID === 'string' ? record.modelID.trim() : ''
  if (providerID && modelID) return `${providerID}/${modelID}`
  const model = record.model
  if (typeof model === 'string' && model.trim()) return model.trim()
  if (model && typeof model === 'object' && !Array.isArray(model)) {
    const nested = model as Record<string, unknown>
    const provider = typeof nested.providerID === 'string'
      ? nested.providerID.trim()
      : (typeof nested.provider === 'string' ? nested.provider.trim() : '')
    const id = typeof nested.modelID === 'string'
      ? nested.modelID.trim()
      : (typeof nested.id === 'string' ? nested.id.trim() : '')
    if (provider && id) return `${provider}/${id}`
  }
  return null
}

export function readSessionBranchLabel(session: unknown): string | null {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const record = session as Record<string, unknown>
  if (typeof record.branch === 'string' && record.branch.trim()) return record.branch.trim()
  const project = record.project
  if (project && typeof project === 'object' && !Array.isArray(project)) {
    const branch = (project as { branch?: unknown }).branch
    if (typeof branch === 'string' && branch.trim()) return branch.trim()
  }
  return null
}
