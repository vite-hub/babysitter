// The model API key never leaves this host. A remote pass gets a random token that only this relay
// accepts; the relay swaps it for the real key and forwards the request to the model provider.
// Releasing the lease revokes the token, so a token read from a remote process stops working.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'

export interface ModelRelay {
  /** Loopback port of the relay on this host. */
  readonly port: number
  /** A token for one lease. `revoke` makes the relay refuse it. */
  issue(): { token: string, revoke(): void }
  close(): Promise<void>
}

const hopHeaders = new Set(['authorization', 'connection', 'host', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/** `upstream` is the provider's origin; requests keep their path. */
export async function startModelRelay(options: { upstream: string, apiKey: string }): Promise<ModelRelay> {
  const upstream = new URL(options.upstream)
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest
  const tokens = new Set<string>()
  const server = createServer((request, response) => {
    const presented = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
    if (!presented || !tokens.has(digest(presented))) {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"placement relay token is not valid"}}')
      request.resume()
      return
    }
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(request.headers)) if (!hopHeaders.has(name)) headers[name] = value
    headers.authorization = `Bearer ${options.apiKey}`
    // The remote base URL keeps the upstream path, so the request path passes through unchanged.
    const forward = send({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    })
    forward.once('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `placement relay: ${error.message}` } }))
    })
    response.once('close', () => forward.destroy())
    request.pipe(forward)
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => server.once('listening', resolve).once('error', reject))
  return {
    port: (server.address() as AddressInfo).port,
    issue() {
      const token = randomBytes(32).toString('base64url')
      const key = digest(token)
      tokens.add(key)
      return { token, revoke: () => { tokens.delete(key) } }
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
