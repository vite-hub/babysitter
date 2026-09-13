export const defaultMaxOwners = '1'

export function resolveRepositories(repositories: string, repository: string) {
  const configured = repositories.trim() || repository
  const resolved = [...new Set(configured.split(/[\s,]+/).filter(Boolean).map(value => value.toLowerCase()))]
  if (resolved.length === 0) throw new Error('At least one Babysitter repository is required.')
  for (const value of resolved) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid GitHub repository: ${value}`)
  }
  return resolved
}

export function resolveMaxOwners(value: string) {
  const maxOwners = Number(value)
  if (!Number.isInteger(maxOwners) || maxOwners < 1) throw new Error(`Invalid Babysitter owner limit: ${value}`)
  return maxOwners
}
