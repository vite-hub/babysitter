import { reconcileBabysitterWork } from '../../babysitter.schedule.ts'

export default defineEventHandler(async () => {
  await reconcileBabysitterWork('http', { track: promise => promise })
  return { ok: true }
})
