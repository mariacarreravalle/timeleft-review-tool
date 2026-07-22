import { NextRequest } from 'next/server'
import { isAuthenticated, noStoreJson, unauthorized } from '../../lib/serverAuth'

export const maxDuration = 60
export const runtime = 'nodejs'

const CHAT_MODEL = process.env.CHAT_MODEL || process.env.ANALYSIS_MODEL || 'claude-sonnet-5'

const MAX_QUESTION_CHARS = 1000
const MAX_HISTORY_TURNS = 8
const MAX_CONTEXT_REVIEWS = 80
const MAX_REVIEW_CHARS = 280
const MAX_THEMES = 12

export interface ChatReview {
  rating: number
  date: string
  country: string
  text: string
}

export interface ChatTheme {
  name: string
  count: number
  percentage: number
  impact: number
  team: string
  action: string
  sentiment: number
  quotes: string[]
}

export interface ChatContext {
  filterLabel: string
  totalReviews: number
  sentiment: { negative: number; neutral: number; positive: number; unrated: number }
  dateRange: { earliest: string; latest: string } | null
  themes: ChatTheme[]
  reviews: ChatReview[]
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthenticated(req)) return unauthorized()

    if (!process.env.ANTHROPIC_API_KEY) {
      return noStoreJson({ error: 'Chat is not configured.' }, { status: 500 })
    }

    const body = await req.json() as {
      question?: string
      history?: ChatMessage[]
      context?: ChatContext
    }

    const question = String(body.question || '').trim()
    if (!question) {
      return noStoreJson({ error: 'Please enter a question.' }, { status: 400 })
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return noStoreJson({ error: 'Question is too long.' }, { status: 400 })
    }
    if (!body.context || typeof body.context !== 'object') {
      return noStoreJson({ error: 'Missing analysis context.' }, { status: 400 })
    }

    const context = sanitizeContext(body.context)
    const history = sanitizeHistory(body.history)

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 1200,
        thinking: { type: 'disabled' },
        system: buildSystemPrompt(context),
        messages: [
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: question },
        ],
      }),
    })

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text()
      console.error('Claude chat API error:', err.slice(0, 500))
      return noStoreJson({ error: 'Chat service error. Please try again.' }, { status: 500 })
    }

    const claudeData = await claudeResponse.json() as {
      content?: Array<{ type: string; text?: string }>
    }
    const answer = (claudeData.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
      .trim()

    if (!answer) {
      return noStoreJson({ error: 'Empty response from the analyst. Try again.' }, { status: 502 })
    }

    return noStoreJson({ answer })
  } catch (error) {
    console.error('Chat error:', error)
    return noStoreJson({ error: 'Chat failed' }, { status: 500 })
  }
}

function sanitizeHistory(raw: ChatMessage[] | undefined): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({
      role: m.role,
      content: m.content.trim().slice(0, MAX_QUESTION_CHARS * 2),
    }))
    .filter(m => m.content.length > 0)
    .slice(-MAX_HISTORY_TURNS)
}

function sanitizeContext(raw: ChatContext): ChatContext {
  const themes = (Array.isArray(raw.themes) ? raw.themes : [])
    .slice(0, MAX_THEMES)
    .map(t => ({
      name: String(t?.name || 'Untitled').slice(0, 120),
      count: Number(t?.count) || 0,
      percentage: Number(t?.percentage) || 0,
      impact: Number(t?.impact) || 0,
      team: String(t?.team || 'Other').slice(0, 40),
      action: String(t?.action || '').slice(0, 200),
      sentiment: Number(t?.sentiment) || 0,
      quotes: (Array.isArray(t?.quotes) ? t.quotes : [])
        .slice(0, 2)
        .map(q => String(q || '').slice(0, 180))
        .filter(Boolean),
    }))

  const reviews = (Array.isArray(raw.reviews) ? raw.reviews : [])
    .slice(0, MAX_CONTEXT_REVIEWS)
    .map(r => ({
      rating: Number(r?.rating) || 0,
      date: String(r?.date || '').slice(0, 32),
      country: String(r?.country || '').slice(0, 8),
      text: String(r?.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REVIEW_CHARS),
    }))
    .filter(r => r.text.length > 0)

  const s = raw.sentiment || { negative: 0, neutral: 0, positive: 0, unrated: 0 }

  return {
    filterLabel: String(raw.filterLabel || 'Current view').slice(0, 200),
    totalReviews: Number(raw.totalReviews) || reviews.length,
    sentiment: {
      negative: Number(s.negative) || 0,
      neutral: Number(s.neutral) || 0,
      positive: Number(s.positive) || 0,
      unrated: Number(s.unrated) || 0,
    },
    dateRange: raw.dateRange
      ? {
          earliest: String(raw.dateRange.earliest || ''),
          latest: String(raw.dateRange.latest || ''),
        }
      : null,
    themes,
    reviews,
  }
}

function buildSystemPrompt(context: ChatContext): string {
  const rated = context.sentiment.negative + context.sentiment.neutral + context.sentiment.positive
  const pct = (n: number) => (rated > 0 ? Math.round((n / rated) * 100) : 0)

  const themeBlock = context.themes.length
    ? context.themes.map((t, i) => {
        const quotes = t.quotes.length ? ` Quotes: ${t.quotes.map(q => `"${q}"`).join(' | ')}` : ''
        return `${i + 1}. ${t.name} [${t.team}] — ${t.percentage}% (${t.count}/${context.totalReviews}), impact ${Math.round(t.impact * 100)}/100, sentiment ${t.sentiment.toFixed(2)}. Action: ${t.action || 'n/a'}.${quotes}`
      }).join('\n')
    : 'No themes in the current filtered view.'

  const reviewBlock = context.reviews.length
    ? context.reviews.map((r, i) =>
        `${i + 1}. ${r.rating || '?'}★ | ${r.country || '??'} | ${r.date || '?'} | ${r.text}`
      ).join('\n')
    : 'No review texts included for this slice.'

  return `You are the Timeleft Review Analyst — a concise product analyst helping Timeleft colleagues interpret app-store review data.

Rules:
- Answer ONLY using the dashboard context and review sample below. If something isn't in the data, say so.
- Respect the current filter scope: ${context.filterLabel}.
- Prefer concrete numbers (counts, %, impact scores, team owners) over vague claims.
- Keep answers short and decision-oriented.
- Format for a chat UI that renders markdown: lead with one clear recommendation in **bold**, then a short blank line, then 2–5 bullet points ("- ...") with the why / evidence. Avoid walls of text on one line.
- Do not invent themes, quotes, or ratings that aren't present.
- Country codes in the data are ISO-style (e.g. FR = France, GB = United Kingdom).
- British English spelling.

CURRENT FILTER SCOPE: ${context.filterLabel}
REVIEWS IN SCOPE: ${context.totalReviews}
DATE RANGE: ${context.dateRange ? `${context.dateRange.earliest} – ${context.dateRange.latest}` : 'unknown'}
SENTIMENT (from star ratings): ${pct(context.sentiment.negative)}% negative, ${pct(context.sentiment.neutral)}% neutral, ${pct(context.sentiment.positive)}% positive

THEMES (ranked by impact, current filters):
${themeBlock}

SAMPLE REVIEWS IN SCOPE (up to ${MAX_CONTEXT_REVIEWS}):
${reviewBlock}`
}
