'use client'

import { FormEvent, useEffect, useState } from 'react'

export default function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/auth', { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
        const data = await res.json().catch(() => null) as { ok?: boolean } | null
        if (!cancelled) setAuthed(!!data?.ok)
      } catch {
        if (!cancelled) setAuthed(false)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(false)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        setError(true)
        return
      }
      setAuthed(true)
      setPassword('')
    } catch {
      setError(true)
    } finally {
      setSubmitting(false)
    }
  }

  if (!ready) {
    return <div className="min-h-screen" aria-hidden />
  }

  if (authed) return <>{children}</>

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm text-center">
        <div className="brand-lockup justify-center">
          <span className="brand-name">Timeleft</span>
          <span className="brand-product">Review Analyser</span>
        </div>
        <p className="page-desc mt-3.5 mx-auto mb-9">
          Enter the access password to continue.
        </p>

        <label htmlFor="access-password" className="sr-only">Password</label>
        <div className="relative">
          <input
            id="access-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={e => {
              setPassword(e.target.value)
              if (error) setError(false)
            }}
            placeholder="Password"
            className={`w-full h-10 rounded-pill border bg-white pl-5 pr-12 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent ${
              error ? 'border-red-500' : 'border-tan'
            }`}
          />
          <button
            type="button"
            onClick={() => setShowPassword(v => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-muted-dark hover:text-ink transition"
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        {error && (
          <p className="mt-3 text-sm font-medium text-red-600" role="alert">
            Incorrect password
          </p>
        )}
        <button type="submit" disabled={submitting} className="btn-primary w-full mt-4 h-10 disabled:opacity-60">
          {submitting ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}
