import { defineConsoleAuthorize } from 'vite-hub/console/auth'

// The service is exposed through the host's private deployment boundary. Keep
// ViteHub's route-level check explicit while leaving authentication to that
// boundary.
export default defineConsoleAuthorize(() => true)
