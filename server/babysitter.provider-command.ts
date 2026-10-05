/** Resolve the provider executable from the service environment. */
export function resolveProviderCommand(configured = process.env.BABYSITTER_PROVIDER_COMMAND): string {
  return configured?.trim() || 'codex'
}
