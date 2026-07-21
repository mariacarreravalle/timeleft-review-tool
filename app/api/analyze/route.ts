import { NextRequest, NextResponse } from 'next/server'

// Vercel kills serverless functions at 10s by default (Hobby plan). Classifying
// all reviews can take 15-30s, so raise the ceiling or the request 504s.
export const maxDuration = 60
export const runtime = 'nodejs'

// Model is env-overridable. Default to Sonnet: fast + good enough for clustering.
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'claude-sonnet-5'

const TEAMS = ['Product', 'Tech', 'CX & Support', 'Ops', 'Marketing', 'Other'] as const
type Team = typeof TEAMS[number]

// Structured-output schema forces valid, parseable JSON. The model returns a
// theme taxonomy where each theme lists the indices of the reviews that express
// it; the CLIENT computes counts/sentiment/quotes/charts so the whole dashboard
// can be re-sliced by region (country/city) instantly without another AI call.
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
        required: ['name', 'team', 'action', 'reviewIndexes'],
        properties: {
          name: { type: 'string' },
          team: { type: 'string', enum: TEAMS as unknown as string[] },
          action: { type: 'string' },
          reviewIndexes: { type: 'array', items: { type: 'integer' } }
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

interface ThemeTaxonomy {
  name: string
  team: Team
  action: string
  reviewIndexes: number[] // 0-based indices into the reviews array (multi-label)
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
        max_tokens: 8192, // reviewIndexes lists can be long
        // Structured extraction, not a reasoning task — disable Sonnet's default
        // adaptive thinking to cut latency and variance.
        thinking: { type: 'disabled' },
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

    const themes = parseTaxonomy(analysisText, reviews.length)

    if (themes.length === 0) {
      return NextResponse.json(
        { error: 'The analysis came back empty. Try again — if it persists, the review text may be too short to cluster.' },
        { status: 502 }
      )
    }

    return NextResponse.json({ themes })
  } catch (error) {
    console.error('Analysis error:', error)
    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 })
  }
}

function buildAnalysisPrompt(reviews: Review[]): string {
  const body = reviews
    .map((r, i) => `${i + 1} | ${r.rating || '?'}★ | ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n')

  return `You are a product analyst at Timeleft (an app that seats strangers together for dinners). Below are ALL ${reviews.length} app-store reviews, one per line as "index | rating | text". Cluster them into 6-8 concrete, actionable themes.

For EACH theme return:
- "name": specific and actionable (e.g. "Subscription pricing complaints", "App crashes & login bugs") — not a sentiment label like "negative feedback".
- "team": which internal team should own it — exactly one of "Product", "Tech", "CX & Support", "Ops", "Marketing", "Other". Guidance: app bugs/crashes/performance/login issues → Tech; product decisions like pricing/subscription model, features, matching algorithm, city coverage → Product; billing disputes, refunds, cancellation help, complaint handling, support responsiveness → CX & Support; event logistics, restaurant/venue operations, no-shows, on-the-ground execution → Ops; brand perception, expectations set by ads, acquisition/growth → Marketing; anything that fits none of these → Other.
- "action": one concrete next step for that team, max ~18 words.
- "reviewIndexes": the index numbers (from the list below) of every review that expresses this theme. Read them all. A review can appear under more than one theme (multi-label). This is what drives the counts a team acts on, so be thorough — include every relevant index.

REVIEWS:
${body}

Respond with ONLY valid JSON, no markdown:
{"themes":[{"name":"...","team":"Product","action":"...","reviewIndexes":[1,4,9]}]}`
}

function parseTaxonomy(text: string, total: number): ThemeTaxonomy[] {
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    return (parsed.themes || [])
      .map((t: any): ThemeTaxonomy => {
        // Model returns 1-based indices; convert to 0-based, clamp to range, dedupe.
        const seen = new Set<number>()
        const reviewIndexes: number[] = []
        for (const raw of Array.isArray(t.reviewIndexes) ? t.reviewIndexes : []) {
          const idx = Math.round(Number(raw)) - 1
          if (Number.isInteger(idx) && idx >= 0 && idx < total && !seen.has(idx)) {
            seen.add(idx)
            reviewIndexes.push(idx)
          }
        }
        return {
          name: String(t.name || 'Untitled theme'),
          team: normalizeTeam(t.team),
          action: String(t.action || '').trim(),
          reviewIndexes
        }
      })
      .filter((t: ThemeTaxonomy) => t.reviewIndexes.length > 0)
  } catch (err) {
    console.error('Parse error:', err)
    return []
  }
}

function normalizeTeam(raw: any): Team {
  const s = String(raw || '').trim().toLowerCase()
  const match = TEAMS.find(t => t.toLowerCase() === s)
  return match || 'Other'
}
