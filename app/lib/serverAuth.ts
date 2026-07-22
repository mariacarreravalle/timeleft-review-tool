import { createHmac, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

export const SESSION_COOKIE = 'timeleft_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14 // 14 days

/** Access password — server-only. Set APP_ACCESS_PASSWORD in env (required in production). */
export function getAccessPassword(): string {
  const fromEnv = process.env.APP_ACCESS_PASSWORD?.trim()
  if (fromEnv) return fromEnv
  // Local-dev fallback only. Production must set APP_ACCESS_PASSWORD.
  if (process.env.NODE_ENV !== 'production') return 'TL26MCV'
  return ''
}

function getSigningSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim() || process.env.APP_ACCESS_PASSWORD?.trim()
  if (secret) return secret
  if (process.env.NODE_ENV !== 'production') return 'dev-only-auth-secret'
  return ''
}

export function passwordsMatch(provided: string, expected: string): boolean {
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Constant-time-ish reject without leaking length via early return alone.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export function createSessionToken(): string | null {
  const secret = getSigningSecret()
  if (!secret) return null
  const exp = Date.now() + SESSION_TTL_MS
  const payload = `v1.${exp}`
  const sig = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false
  const secret = getSigningSecret()
  if (!secret) return false

  const parts = token.split('.')
  if (parts.length !== 3) return false
  const [version, expRaw, sig] = parts
  if (version !== 'v1' || !expRaw || !sig) return false

  const exp = Number(expRaw)
  if (!Number.isFinite(exp) || Date.now() > exp) return false

  const payload = `${version}.${expRaw}`
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function isAuthenticated(req: NextRequest): boolean {
  return verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function applySessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}

export function noStoreJson(data: unknown, init?: { status?: number }): NextResponse {
  const res = NextResponse.json(data, { status: init?.status ?? 200 })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
