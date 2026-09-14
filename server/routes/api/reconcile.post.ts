import { reconcileBabysitterWork } from '../../babysitter.schedule.ts'

export default defineEventHandler(async () => {
  try {
    await reconcileBabysitterWork('http', { track: promise => promise })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})
