export default defineEventHandler(async () => {
  try {
    const { reconcileBabysitterWork } = await import('../../babysitter.schedule.ts')
    await reconcileBabysitterWork('http', { track: promise => promise })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})
