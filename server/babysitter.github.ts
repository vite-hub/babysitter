/** Installation IDs are configuration; tokens and private keys stay in the GitHub host. */
export function parseGitHubInstallations(value: string): Record<string, string> {
  const installations: Record<string, string> = Object.create(null)
  if (!value.trim()) return installations
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GITHUB_APP_INSTALLATIONS must be a JSON object mapping owners to installation IDs.')
  }
  for (const [owner, id] of Object.entries(parsed)) {
    if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner)
      || !['number', 'string'].includes(typeof id)
      || !/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
      throw new Error(`Invalid GitHub App installation for ${owner}.`)
    }
    const key = owner.toLowerCase()
    if (key in installations) throw new Error(`Duplicate GitHub App owner: ${owner}.`)
    installations[key] = String(id)
  }
  return installations
}
