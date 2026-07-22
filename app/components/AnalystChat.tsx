'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'

export interface AnalystChatContext {
  filterLabel: string
  totalReviews: number
  sentiment: { negative: number; neutral: number; positive: number; unrated: number }
  dateRange: { earliest: string; latest: string } | null
  themes: Array<{
    name: string
    count: number
    percentage: number
    impact: number
    team: string
    action: string
    sentiment: number
    quotes: string[]
  }>
  reviews: Array<{
    rating: number
    date: string
    country: string
    text: string
  }>
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const EXAMPLE_PROMPTS = [
  'What is the most urgent issue to fix based on French reviews?',
  'Which team should act first, and why?',
  'Summarise the top three complaints in plain English.',
  'What are people saying about pricing or subscriptions?',
]

export default function AnalystChat({ context }: { context: AnalystChatContext }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages, loading])

  const ask = async (question: string) => {
    const q = question.trim()
    if (!q || loading) return

    setError('')
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setLoading(true)

    try {
      const history = messages.slice(-8)
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history, context }),
      })

      const body = await response.json().catch(() => null) as { answer?: string; error?: string } | null
      if (!response.ok) {
        throw new Error(body?.error || `Chat failed (HTTP ${response.status})`)
      }
      if (!body?.answer) {
        throw new Error('Empty response from the analyst.')
      }

      setMessages(prev => [...prev, { role: 'assistant', content: body.answer! }])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chat failed'
      setError(msg)
      setMessages(prev => prev.slice(0, -1))
      setInput(q)
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void ask(input)
  }

  return (
    <div className="panel p-6 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-ink">Ask the analyst</h2>
          <p className="text-sm text-muted-dark mt-1.5 max-w-md leading-relaxed">
            Ask in plain English about the reviews in your current filters. Answers use this slice only.
          </p>
        </div>
        <p className="text-[11px] text-muted shrink-0 sm:text-right leading-snug">
          Scope: {context.filterLabel}
          <br />
          {context.totalReviews.toLocaleString()} reviews in view
        </p>
      </div>

      {messages.length === 0 && !loading && (
        <div className="flex flex-wrap gap-2 mb-5">
          {EXAMPLE_PROMPTS.map(prompt => (
            <button
              key={prompt}
              type="button"
              onClick={() => void ask(prompt)}
              className="rounded-pill border border-tan bg-cream px-3.5 h-8 text-xs font-semibold text-ink hover:border-accent transition text-left max-w-full"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-tan bg-cream/40 min-h-[12rem] max-h-80 overflow-y-auto p-4 mb-4 space-y-3">
        {messages.length === 0 && !loading ? (
          <p className="text-sm text-muted-dark leading-relaxed">
            Try an example above, or type your own question — for example about a country, theme, or team.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={`${m.role}-${i}`}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[90%] sm:max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-ink text-cream'
                    : 'bg-white border border-tan text-ink'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-tan rounded-2xl px-3.5 py-2.5 text-sm text-muted-dark inline-flex items-center gap-2">
              <span className="h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p className="text-sm font-medium text-red-600 mb-3" role="alert">{error}</p>
      )}

      <form onSubmit={onSubmit} className="flex gap-2.5 items-center">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask about this slice of reviews…"
          disabled={loading}
          className="flex-1 min-w-0 h-9 rounded-pill border border-tan bg-cream px-5 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent disabled:opacity-60"
          aria-label="Ask the analyst"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="btn-primary"
        >
          Ask
        </button>
      </form>
    </div>
  )
}
