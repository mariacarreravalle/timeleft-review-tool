import { NextRequest } from 'next/server'
import { isAuthenticated, noStoreJson, unauthorized } from '../../lib/serverAuth'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_BODY_BYTES = 800_000

export async function POST(req: NextRequest) {
  try {
    if (!isAuthenticated(req)) return unauthorized()

    const webhookUrl = process.env.MAKE_WEBHOOK_URL?.trim()
    if (!webhookUrl) {
      return noStoreJson(
        { error: 'Monthly digest is not configured (missing MAKE_WEBHOOK_URL).' },
        { status: 500 }
      )
    }

    const raw = await req.text()
    if (!raw) {
      return noStoreJson({ error: 'Missing digest payload.' }, { status: 400 })
    }
    if (raw.length > MAX_BODY_BYTES) {
      return noStoreJson({ error: 'Digest payload is too large.' }, { status: 413 })
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return noStoreJson({ error: 'Invalid JSON payload.' }, { status: 400 })
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return noStoreJson({ error: 'Digest payload must be an object.' }, { status: 400 })
    }

    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Make webhooks should answer quickly; don't hang the UI forever.
      signal: AbortSignal.timeout(20_000),
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      console.error('Make webhook error:', upstream.status, detail.slice(0, 500))
      return noStoreJson(
        { error: `Make webhook returned HTTP ${upstream.status}.` },
        { status: 502 }
      )
    }

    return noStoreJson({ ok: true })
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    console.error('Digest forward error:', error)
    return noStoreJson(
      { error: timedOut ? 'Make webhook timed out.' : 'Failed to send digest.' },
      { status: timedOut ? 504 : 500 }
    )
  }
}
