'use client'

import { FormEvent, useEffect, useState } from 'react'

const STORAGE_KEY = 'timeleft-review-auth'
const PASSWORD = 'TL26MCV'

export default function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false)
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    try {
      setAuthed(localStorage.getItem(STORAGE_KEY) === '1')
    } catch {
      setAuthed(false)
    }
    setReady(true)
  }, [])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (password === PASSWORD) {
      try {
        localStorage.setItem(STORAGE_KEY, '1')
      } catch {
        // Still unlock this session even if storage is blocked.
      }
      setAuthed(true)
      setError(false)
      setPassword('')
      return
    }
    setError(true)
  }

  if (!ready) {
    return <div className="min-h-screen bg-cream" aria-hidden />
  }

  if (authed) return <>{children}</>

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-cream px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm text-center">
        <div className="flex items-baseline justify-center gap-2 mb-2">
          <span className="text-2xl font-extrabold tracking-tight text-ink">Timeleft</span>
          <span className="text-2xl font-medium text-muted-dark">Review Analyzer</span>
        </div>
        <p className="text-sm text-muted-dark mb-8">Enter the access password to continue.</p>

        <label htmlFor="access-password" className="sr-only">Password</label>
        <input
          id="access-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={e => {
            setPassword(e.target.value)
            if (error) setError(false)
          }}
          placeholder="Password"
          className={`w-full rounded-pill border bg-white px-5 py-3 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent ${
            error ? 'border-red-500' : 'border-tan'
          }`}
        />
        {error && (
          <p className="mt-3 text-sm font-medium text-red-600" role="alert">
            Incorrect password
          </p>
        )}
        <button
          type="submit"
          className="w-full mt-4 rounded-pill bg-ink hover:bg-black text-cream font-semibold py-3 px-6 transition"
        >
          Unlock
        </button>
      </form>
    </div>
  )
}
