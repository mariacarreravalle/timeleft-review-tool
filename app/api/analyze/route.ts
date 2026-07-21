import { NextRequest, NextResponse } from 'next/server'

// Vercel kills serverless functions at 10s by default (Hobby plan). Classifying
// all reviews can take 15-30s, so raise the ceiling or the request 504s.
export const maxDuration = 60
export const runtime = 'nodejs'

// Model is env-overridable. Default to Sonnet: fast + good enough for clustering.
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'claude-sonnet-5'

const TEAMS = ['Product', 'Tech', 'CX & Support', 'Ops', 'Marketing', 'Other'] as const
type Team = typeof TEAMS[number]

// Structured-output schema: forces the model to return valid, parseable JSON.
// Without this, verbatim quotes containing " characters break JSON.parse.
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'count', 'sentiment', 'team', 'action', 'quotes'],
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
          sentiment: { type: 'number' },
          team: { type: 'string', enum: TEAMS as unknown as string[] },
          action: { type: 'string' },
          quotes: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
} as const

interface Review {
  date: string
  rating: number
  text: string
}

interface Theme {
  name: string
  count: number        // reviews Claude classified into this theme (grounded in all reviews)
  percentage: number   // count / totalReviews * 100
  sentiment: number    // -1..1, AI text sentiment for the theme
  impact: number       // 0..1 ranking score (volume-weighted, negativity + urgency)
  team: Team
  action: string
  quotes: string[]     // up to 3 verbatim quotes
}

interface SentimentBreakdown {
  negative: number
  neutral: number
  positive: number
  unrated: number
}

export async function POST(req: NextRequest) {
  try {
    const { reviews } = await req.json() as { reviews: Review[] }

    if (!reviews || reviews.length === 0) {
      return NextResponse.json({ error: 'No reviews provided' }, { status: 400 })
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY is not set. Add it in your .env.local (local) or Vercel project settings (deployed).' },
        { status: 500 }
      )
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        max_tokens: 4096,
        // Structured extraction, not a reasoning task — disable Sonnet's default
        // adaptive thinking to cut latency and variance.
        thinking: { type: 'disabled' },
        // Guarantee valid JSON matching our schema (quotes contain " chars).
        output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        messages: [{ role: 'user', content: buildAnalysisPrompt(reviews) }]
      })
    })

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text()
      console.error('Claude API error:', err)
      return NextResponse.json({ error: 'Analysis service error' }, { status: 500 })
    }

    const claudeData = await claudeResponse.json() as any
    // Don't assume content[0] is text — models with thinking on put a thinking
    // block first. Grab the actual text block(s).
    const analysisText = (claudeData.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')

    const totalReviews = reviews.length
    const themes = parseThemesFromResponse(analysisText, totalReviews)

    if (themes.length === 0) {
      return NextResponse.json(
        { error: 'The analysis came back empty. Try again — if it persists, the review text may be too short to cluster.' },
        { status: 502 }
      )
    }

    return NextResponse.json({
      totalReviews,
      sentiment: buildSentimentBreakdown(reviews),
      themes,
      overallRatings: buildRatingChart(reviews),
      volumeOverTime: buildVolumeChart(reviews)
    })
  } catch (error) {
    console.error('Analysis error:', error)
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
  }
}

function buildAnalysisPrompt(reviews: Review[]): string {
  // Send every review (truncated) so theme counts are grounded in the full set,
  // not extrapolated from a sample.
  const body = reviews
    .map((r, i) => `${i + 1} | ${r.rating || '?'}★ | ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n')

  return `You are a product analyst at Timeleft (an app that seats strangers together for dinners). Below are ALL ${reviews.length} app-store reviews, one per line as "index | rating | text". Cluster them into 6-8 concrete, actionable themes.

For EACH theme return:
- "name": specific and actionable (e.g. "Subscription pricing complaints", "App crashes & login bugs") — not a sentiment label like "negative feedback".
- "count": how many of the ${reviews.length} reviews above mention or express this theme (integer). A review can count toward more than one theme (multi-label). Read them all and be realistic — this drives percentages a team will act on.
- "sentiment": average sentiment for the theme, -1 (very negative) to +1 (very positive).
- "team": which internal team should own it — exactly one of "Product", "Tech", "CX & Support", "Ops", "Marketing", "Other". Guidance: app bugs/crashes/performance/login issues → Tech; product decisions like pricing/subscription model, features, matching algorithm, city coverage → Product; billing disputes, refunds, cancellation help, complaint handling, support responsiveness → CX & Support; event logistics, restaurant/venue operations, no-shows, on-the-ground execution → Ops; brand perception, expectations set by ads, acquisition/growth → Marketing; anything that fits none of these → Other.
- "action": one concrete next step for that team, max ~18 words.
- "quotes": exactly 3 SHORT quotes copied VERBATIM from the reviews above that best evidence this theme.

REVIEWS:
${body}

Respond with ONLY valid JSON, no markdown:
{"themes":[{"name":"...","count":120,"sentiment":-0.8,"team":"Product","action":"...","quotes":["...","...","..."]}]}`
}

function parseThemesFromResponse(text: string, total: number): Theme[] {
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    return (parsed.themes || [])
      .map((t: any): Theme => {
        const count = Math.min(Math.max(Math.round(t.count) || 0, 0), total)
        const sentiment = clamp(Number(t.sentiment) || 0, -1, 1)
        const quotes = Array.isArray(t.quotes) ? t.quotes.slice(0, 3) : []
        return {
          name: String(t.name || 'Untitled theme'),
          count,
          percentage: total > 0 ? Math.round((count / total) * 100) : 0,
          sentiment,
          impact: calculateImpact(count, sentiment, total, quotes),
          team: normalizeTeam(t.team),
          action: String(t.action || '').trim(),
          quotes
        }
      })
      .sort((a: Theme, b: Theme) => b.impact - a.impact)
  } catch (err) {
    console.error('Parse error:', err)
    return []
  }
}

// Urgency is volume-led, amplified by negativity and hard-signal keywords.
function calculateImpact(count: number, sentiment: number, total: number, quotes: string[]): number {
  const volumeShare = total > 0 ? count / total : 0
  const negativity = sentiment < 0 ? -sentiment : 0
  const urgencyKeywords = ['cancel', 'refund', 'uninstall', 'waste', 'scam', 'bug', 'crash', 'error', 'charge', 'unsubscribe']
  const hasUrgency = quotes.some(q => urgencyKeywords.some(kw => String(q).toLowerCase().includes(kw)))
  return clamp(volumeShare * 0.6 + negativity * 0.25 + (hasUrgency ? 0.15 : 0), 0, 1)
}

function normalizeTeam(raw: any): Team {
  const s = String(raw || '').trim().toLowerCase()
  const match = TEAMS.find(t => t.toLowerCase() === s)
  return match || 'Other'
}

// Sentiment top-line is derived from the actual 1-5 star ratings (ground truth),
// not AI text sentiment: 1-2 negative, 3 neutral, 4-5 positive.
function buildSentimentBreakdown(reviews: Review[]): SentimentBreakdown {
  const b: SentimentBreakdown = { negative: 0, neutral: 0, positive: 0, unrated: 0 }
  for (const r of reviews) {
    if (r.rating >= 4) b.positive++
    else if (r.rating === 3) b.neutral++
    else if (r.rating >= 1) b.negative++
    else b.unrated++
  }
  return b
}

function buildRatingChart(reviews: Review[]): Array<{ rating: number; count: number }> {
  const counts: { [key: number]: number } = {}
  reviews.forEach(r => {
    if (r.rating > 0) counts[r.rating] = (counts[r.rating] || 0) + 1
  })
  return [1, 2, 3, 4, 5].map(rating => ({ rating, count: counts[rating] || 0 }))
}

function buildVolumeChart(reviews: Review[]): Array<{ date: string; count: number }> {
  const byDate: { [key: string]: number } = {}
  reviews.forEach(r => {
    if (r.date) {
      const date = r.date.split('T')[0]
      byDate[date] = (byDate[date] || 0) + 1
    }
  })
  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }))
    .slice(-30)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}
