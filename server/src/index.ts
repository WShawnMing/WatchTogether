const port = Number(process.env.PORT ?? 4000)
const roomIdleTtlMinutes = Number(process.env.ROOM_IDLE_TTL_MINUTES ?? 120)
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'

import('./localRelay.js')
  .then(({ startLocalRelay }) =>
    startLocalRelay({ port, roomIdleTtlMinutes }),
  )
  .then((relay) => {
    console.log(
      `watchtogether local relay listening on http://0.0.0.0:${relay.port}`,
    )
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
