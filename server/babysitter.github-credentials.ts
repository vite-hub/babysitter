type GitHubCredentials = {
  appId?: string
  owner: string
  installationId: string
  privateKey?: unknown
  [key: string]: unknown
}

export class GitHubAppInstallationRequired extends Error {
  constructor(owner: string) {
    super(`Install vitehub-bot on ${owner} and add its installation ID to GITHUB_APP_INSTALLATIONS before Babysitter works on that owner's repositories.`)
    this.name = 'GitHubAppInstallationRequired'
  }
}

export function credentialsForRepository<T extends GitHubCredentials>(
  credentials: T,
  repository: string | undefined,
  installationsJson: string | undefined,
): T {
  if (!repository) throw new Error('GitHub App credentials require a repository')
  if (!credentials.appId?.trim() || !credentials.installationId?.trim() || !credentials.privateKey) {
    throw new Error('Babysitter requires complete vitehub-bot App credentials')
  }

  const repositoryOwner = repository.split('/')[0]!.toLowerCase()
  if (!installationsJson) {
    if (repositoryOwner === credentials.owner.toLowerCase()) return credentials
    throw new GitHubAppInstallationRequired(repositoryOwner)
  }

  let installations: Record<string, unknown>
  try {
    installations = JSON.parse(installationsJson)
  }
  catch {
    throw new Error('GITHUB_APP_INSTALLATIONS must be a JSON object of owner to installation ID')
  }
  if (!installations || Array.isArray(installations) || typeof installations !== 'object') {
    throw new Error('GITHUB_APP_INSTALLATIONS must be a JSON object of owner to installation ID')
  }

  const entry = Object.entries(installations).find(([owner]) => owner.toLowerCase() === repositoryOwner)
  if (!entry) {
    if (repositoryOwner === credentials.owner.toLowerCase()) return credentials
    throw new GitHubAppInstallationRequired(repositoryOwner)
  }

  const installationId = Number(entry[1])
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error(`Invalid GitHub App installation ID for ${repositoryOwner}`)
  }
  return { ...credentials, owner: repositoryOwner, installationId: String(installationId) }
}
