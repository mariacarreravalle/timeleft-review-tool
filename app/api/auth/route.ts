import { NextRequest } from 'next/server'
import {
  applySessionCookie,
  clearSessionCookie,
  createSessionToken,
  getAccessPassword,
  isAuthenticated,
  noStoreJson,
  passwordsMatch,
} from '../../lib/serverAuth'

export const runtime = 'nodejs'

/** Check whether the browser already has a valid session cookie. */
export async function GET(req: NextRequest) {
  return noStoreJson({ ok: isAuthenticated(req) })
}

/** Exchange the access password for an httpOnly session cookie. */
export async function POST(req: NextRequest) {
  try {
    const expected = getAccessPassword()
    if (!expected) {
      return noStoreJson(
        { error: 'Access password is not configured on the server.' },
        { status: 500 }
      )
    }

    const body = await req.json().catch(() => null) as { password?: string } | null
    const password = String(body?.password || '')

    if (!passwordsMatch(password, expected)) {
      return noStoreJson({ error: 'Incorrect password' }, { status: 401 })
    }

    const token = createSessionToken()
    if (!token) {
      return noStoreJson(
        { error: 'Auth is not configured on the server.' },
        { status: 500 }
      )
    }

    const res = noStoreJson({ ok: true })
    applySessionCookie(res, token)
    return res
  } catch (error) {
    console.error('Auth login error:', error)
    return noStoreJson({ error: 'Login failed' }, { status: 500 })
  }
}

/** Clear the session cookie (logout). */
export async function DELETE() {
  const res = noStoreJson({ ok: true })
  clearSessionCookie(res)
  return res
}
