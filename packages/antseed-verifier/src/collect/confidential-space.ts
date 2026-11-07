import { CS_AUDIENCE } from '../confidential-space.js'
import { postUnix } from './unix-http.js'

/**
 * Confidential Space collector: asks the container launcher for a Google attestation token
 * carrying `nonce` (the round's binding). The launcher mounts its socket into the workload
 * container; it throws when the socket is absent, so the prover omits the capability elsewhere.
 *
 * Wire contract (POST http://localhost/v1/token over the socket):
 *   request  { "audience": "antseed-verifier", "token_type": "OIDC", "nonces": ["<nonce>"] }
 *   response the signed token (JWT text)
 */
export const CS_LAUNCHER_SOCKET = '/run/container_launcher/teeserver.sock'

export async function generateConfidentialSpaceToken(nonce: string, socketPath = CS_LAUNCHER_SOCKET): Promise<string> {
  const body = JSON.stringify({ audience: CS_AUDIENCE, token_type: 'OIDC', nonces: [nonce] })
  const { status, body: token } = await postUnix(socketPath, '/v1/token', body)
  if (status !== 200) throw new Error(`Confidential Space token request returned HTTP ${status}: ${token.slice(0, 200)}`)
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token.trim())) throw new Error('Confidential Space token response is not a JWT')
  return token.trim()
}
