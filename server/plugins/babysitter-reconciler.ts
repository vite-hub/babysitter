export default defineNitroPlugin(() => {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const { reconcileBabysitterWork } = await import('../babysitter.schedule.ts')
      await reconcileBabysitterWork('timer', { track: promise => promise })
    } catch (error) {
      console.error('[babysitter] reconciliation failed', error)
    } finally {
      running = false
    }
  }
  setTimeout(tick, 2_000)
  setInterval(tick, 15_000)
})
