'use client'

import { FormEvent, useEffect, useRef, useState, type ReactNode } from 'react'

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
        credentials: 'same-origin',
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

      <div
        className="rounded-2xl border border-tan bg-cream/40 min-h-[12rem] max-h-[28rem] overflow-y-auto p-4 sm:p-5 mb-4 space-y-4 cursor-text"
        onClick={() => {
          if (!loading) inputRef.current?.focus()
        }}
      >
        {messages.length === 0 && !loading ? (
          <p className="text-sm text-muted-dark leading-relaxed">
            Try an example above, or type your question in the box below — for example about a country, theme, or team.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={`${m.role}-${i}`}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              onClick={e => e.stopPropagation()}
            >
              {m.role === 'user' ? (
                <div className="max-w-[90%] sm:max-w-[75%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-ink text-cream">
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[95%] sm:max-w-[88%] rounded-2xl px-4 py-3.5 text-sm bg-white border border-tan text-ink shadow-sm">
                  <AssistantMessage content={m.content} />
                </div>
              )}
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start" onClick={e => e.stopPropagation()}>
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

      <form
        onSubmit={onSubmit}
        className="relative z-20 flex gap-2.5 items-center"
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          name="analyst-question"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask about this slice of reviews…"
          disabled={loading}
          autoComplete="off"
          autoCorrect="off"
          spellCheck
          className="flex-1 min-w-0 h-10 rounded-pill border border-tan bg-white px-5 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent disabled:opacity-60 disabled:cursor-not-allowed"
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

/** Renders the lightweight markdown Claude tends to return (bold, lists, paragraphs). */
function AssistantMessage({ content }: { content: string }) {
  const blocks = parseBlocks(content)

  return (
    <div className="space-y-3 leading-relaxed text-[13.5px] sm:text-sm">
      {blocks.map((block, i) => {
        if (block.type === 'ul') {
          return (
            <ul key={i} className="space-y-2 pl-0 list-none">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2.5 items-start">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span className="min-w-0 text-ink/90">{renderInline(item)}</span>
                </li>
              ))}
            </ul>
          )
        }
        if (block.type === 'ol') {
          return (
            <ol key={i} className="space-y-2 pl-0 list-none">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2.5 items-start">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream border border-tan text-[11px] font-bold text-muted-dark">
                    {j + 1}
                  </span>
                  <span className="min-w-0 pt-0.5 text-ink/90">{renderInline(item)}</span>
                </li>
              ))}
            </ol>
          )
        }
        return (
          <p key={i} className="text-ink/90">
            {renderInline(block.text)}
          </p>
        )
      })}
    </div>
  )
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, '\n').trim().split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null

  const flushPara = () => {
    if (!para.length) return
    const text = para.join(' ').replace(/\s+/g, ' ').trim()
    if (text) blocks.push({ type: 'p', text })
    para = []
  }

  const flushList = () => {
    if (!list) return
    blocks.push(list)
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(line)
    const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line)

    if (bullet) {
      flushPara()
      if (!list || list.type !== 'ul') {
        flushList()
        list = { type: 'ul', items: [] }
      }
      list.items.push(bullet[1].trim())
      continue
    }

    if (numbered) {
      flushPara()
      if (!list || list.type !== 'ol') {
        flushList()
        list = { type: 'ol', items: [] }
      }
      list.items.push(numbered[2].trim())
      continue
    }

    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }

    flushList()
    para.push(line.trim())
  }

  flushPara()
  flushList()
  return blocks.length ? blocks : [{ type: 'p', text: content.trim() }]
}

function renderInline(text: string): ReactNode[] {
  // **bold**, *italic*, `code` — enough for analyst answers without a markdown lib.
  const parts: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index))
    }
    const token = match[0]
    if (token.startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>
      )
    } else if (token.startsWith('*')) {
      parts.push(
        <em key={key++} className="italic text-ink/90">
          {token.slice(1, -1)}
        </em>
      )
    } else {
      parts.push(
        <code key={key++} className="rounded bg-cream px-1 py-0.5 text-[12px] font-medium text-ink">
          {token.slice(1, -1)}
        </code>
      )
    }
    last = match.index + token.length
  }

  if (last < text.length) parts.push(text.slice(last))
  return parts
}
