import { NextRequest } from 'next/server'
import { isAuthenticated, noStoreJson, unauthorized } from '../../lib/serverAuth'

// Single-batch analyse is usually 10-30s. Merge is a lighter follow-up call.
// Keep under Vercel's kill window so we can return a JSON 504 instead of a bare gateway timeout.
export const maxDuration = 60
export const runtime = 'nodejs'

const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'claude-sonnet-5'
const MAX_REVIEWS = 5000
const MAX_BATCH = 60
const MAX_REVIEW_CHARS = 2000
const MAX_MERGE_SOURCES = 400
const CLAUDE_TIMEOUT_MS = 50_000

const TEAMS = ['Product', 'Tech', 'CX & Support', 'Ops', 'Marketing', 'Other'] as const
type Team = typeof TEAMS[number]

// Structured-output schema forces valid, parseable JSON. The model returns a
// theme taxonomy where each theme lists the indices of the reviews that express
// it; the CLIENT computes counts/sentiment/quotes/charts so the whole dashboard
// can be re-sliced by region (country/city) instantly without another AI call.
const BATCH_OUTPUT_SCHEMA = {
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

const MERGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['themes'],
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'team', 'action', 'sourceIds'],
        properties: {
          name: { type: 'string' },
          team: { type: 'string', enum: TEAMS as unknown as string[] },
          action: { type: 'string' },
          sourceIds: { type: 'array', items: { type: 'string' } }
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
  reviewIndexes: number[] // 0-based indices into the FULL reviews array (multi-label)
}

interface SourceTheme {
  id: string
  name: string
  team: string
  action: string
  reviewIndexes: number[]
}

/**
 * Two modes, same final shape `{ themes }` the dashboard + Make webhook expect:
 * 1. `{ reviews, indexOffset? }` — cluster one batch (≤100). Indexes are remapped
 *    to the global review array via indexOffset.
 * 2. `{ mergeSources }` — consolidate batch themes into 6-8 final themes.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isAuthenticated(req)) return unauthorized()

    if (!process.env.ANTHROPIC_API_KEY) {
      return noStoreJson({ error: 'Analysis is not configured.' }, { status: 500 })
    }

    const body = await req.json().catch(() => null) as {
      reviews?: Review[]
      indexOffset?: number
      mergeSources?: SourceTheme[]
    } | null

    if (body && Array.isArray(body.mergeSources)) {
      const themes = await mergeSources(body.mergeSources)
      if (themes.length === 0) {
        return noStoreJson(
          { error: 'Could not combine theme batches. Try analysing again.' },
          { status: 502 }
        )
      }
      return noStoreJson({ themes })
    }

    const reviews = Array.isArray(body?.reviews) ? body!.reviews : null
    if (!reviews || reviews.length === 0) {
      return noStoreJson({ error: 'No reviews provided' }, { status: 400 })
    }
    if (reviews.length > MAX_BATCH) {
      return noStoreJson(
        { error: `Batch too large (max ${MAX_BATCH} reviews per request).` },
        { status: 413 }
      )
    }

    const indexOffset = Math.max(0, Math.floor(Number(body?.indexOffset) || 0))
    if (indexOffset + reviews.length > MAX_REVIEWS) {
      return noStoreJson(
        { error: `Too many reviews (max ${MAX_REVIEWS}). Split the export and try again.` },
        { status: 413 }
      )
    }

    const sanitized = reviews.map(r => ({
      date: String(r?.date || '').slice(0, 64),
      rating: Number(r?.rating) || 0,
      text: String(r?.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REVIEW_CHARS),
    }))

    // Keep array length stable so indexOffset stays aligned with the client's
    // full reviews array. Empty rows should already have been dropped at parse time.
    if (sanitized.every(r => !r.text)) {
      return noStoreJson({ error: 'No usable review text found.' }, { status: 400 })
    }

    const themes = await analyzeBatch(sanitized, indexOffset)

    if (themes.length === 0) {
      return noStoreJson(
        { error: 'The analysis came back empty. Try again — if it persists, the review text may be too short to cluster.' },
        { status: 502 }
      )
    }

    return noStoreJson({ themes })
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    console.error('Analysis error:', error)
    return noStoreJson(
      {
        error: timedOut
          ? 'Analysis timed out on this batch. Trying again usually works — hit Analyse once more.'
          : 'Analysis failed',
      },
      { status: timedOut ? 504 : 500 }
    )
  }
}

async function analyzeBatch(reviews: Review[], indexOffset: number): Promise<ThemeTaxonomy[]> {
  const text = await callClaude({
    maxTokens: 8192,
    schema: BATCH_OUTPUT_SCHEMA,
    prompt: buildBatchPrompt(reviews),
  })
  return parseBatchTaxonomy(text, reviews.length, indexOffset)
}

async function mergeSources(rawSources: SourceTheme[]): Promise<ThemeTaxonomy[]> {
  const sources: SourceTheme[] = rawSources
    .slice(0, MAX_MERGE_SOURCES)
    .map((s, i) => ({
      id: String(s?.id || `s${i}`).slice(0, 32),
      name: String(s?.name || 'Untitled theme').slice(0, 120),
      team: normalizeTeam(s?.team),
      action: String(s?.action || '').trim().slice(0, 200),
      reviewIndexes: sanitizeIndexes(s?.reviewIndexes),
    }))
    .filter(s => s.reviewIndexes.length > 0)

  if (sources.length === 0) return []
  if (sources.length <= 8) {
    return sources.map(({ id: _id, ...theme }) => ({
      ...theme,
      team: normalizeTeam(theme.team),
    }))
  }

  try {
    return await mergeWithModel(sources)
  } catch (err) {
    console.error('Theme merge failed, falling back to volume merge:', err)
    return fallbackMerge(sources)
  }
}

async function mergeWithModel(sources: SourceTheme[]): Promise<ThemeTaxonomy[]> {
  const byId = new Map(sources.map(s => [s.id, s]))
  const lines = sources
    .map(s => `${s.id} | ${s.reviewIndexes.length} reviews | team=${s.team} | ${s.name} — ${s.action || '(no action)'}`)
    .join('\n')

  const text = await callClaude({
    maxTokens: 4096,
    schema: MERGE_OUTPUT_SCHEMA,
    prompt: buildMergePrompt(lines, sources.length),
  })

  const cleaned = text.replace(/```json\n?|\n?```/g, '').trim()
  const parsed = JSON.parse(cleaned) as {
    themes?: Array<{ name?: string; team?: string; action?: string; sourceIds?: string[] }>
  }

  const merged = (parsed.themes || [])
    .map((t): ThemeTaxonomy | null => {
      const sourceIds = Array.isArray(t.sourceIds) ? t.sourceIds.map(String) : []
      const seen = new Set<number>()
      const reviewIndexes: number[] = []
      for (const id of sourceIds) {
        const src = byId.get(id)
        if (!src) continue
        for (const idx of src.reviewIndexes) {
          if (!seen.has(idx)) {
            seen.add(idx)
            reviewIndexes.push(idx)
          }
        }
      }
      if (reviewIndexes.length === 0) return null
      return {
        name: String(t.name || 'Untitled theme'),
        team: normalizeTeam(t.team),
        action: String(t.action || '').trim(),
        reviewIndexes,
      }
    })
    .filter((t): t is ThemeTaxonomy => !!t)

  if (merged.length === 0) return fallbackMerge(sources)
  return merged.slice(0, 8)
}

/** If the merge model call fails, collapse near-duplicate names by volume. */
function fallbackMerge(sources: SourceTheme[]): ThemeTaxonomy[] {
  const groups = new Map<string, ThemeTaxonomy>()

  for (const src of sources) {
    const key = src.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        name: src.name,
        team: normalizeTeam(src.team),
        action: src.action,
        reviewIndexes: [...src.reviewIndexes],
      })
      continue
    }
    const seen = new Set(existing.reviewIndexes)
    for (const idx of src.reviewIndexes) {
      if (!seen.has(idx)) {
        seen.add(idx)
        existing.reviewIndexes.push(idx)
      }
    }
    if (!existing.action && src.action) existing.action = src.action
  }

  return [...groups.values()]
    .sort((a, b) => b.reviewIndexes.length - a.reviewIndexes.length)
    .slice(0, 8)
}

async function callClaude(opts: {
  prompt: string
  schema: object
  maxTokens: number
}): Promise<string> {
  const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: opts.maxTokens,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: opts.schema } },
      messages: [{ role: 'user', content: opts.prompt }]
    }),
    // Fail before Vercel returns a bare HTML/empty 504 with no JSON body.
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
  })

  if (!claudeResponse.ok) {
    const err = await claudeResponse.text()
    console.error('Claude API error:', err.slice(0, 500))
    throw new Error('Analysis service error')
  }

  const claudeData = await claudeResponse.json() as { content?: Array<{ type: string; text?: string }> }
  return (claudeData.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('\n')
}

function buildBatchPrompt(reviews: Review[]): string {
  const body = reviews
    .map((r, i) => `${i + 1} | ${r.rating || '?'}★ | ${(r.text || '(no text)').replace(/\s+/g, ' ').slice(0, 240)}`)
    .join('\n')

  return `You are a product analyst at Timeleft (an app that seats strangers together for dinners). Below are ${reviews.length} app-store reviews, one per line as "index | rating | text". Cluster them into 6-8 concrete, actionable themes.

For EACH theme return:
- "name": specific and actionable (e.g. "Subscription pricing complaints", "App crashes & login bugs") — not a sentiment label like "negative feedback".
- "team": which internal team should own it — exactly one of "Product", "Tech", "CX & Support", "Ops", "Marketing", "Other". Guidance: app bugs/crashes/performance/login issues → Tech; product decisions like pricing/subscription model, features, matching algorithm, city coverage → Product; billing disputes, refunds, cancellation help, complaint handling, support responsiveness → CX & Support; event logistics, restaurant/venue operations, no-shows, on-the-ground execution → Ops; brand perception, expectations set by ads, acquisition/growth → Marketing; anything that fits none of these → Other.
- "action": one concrete next step for that team, max ~18 words.
- "reviewIndexes": the index numbers (from the list below) of every review that expresses this theme. Use the 1-based index shown on each line (1..${reviews.length}). A review can appear under more than one theme (multi-label). Be thorough — include every relevant index.

REVIEWS:
${body}

Respond with ONLY valid JSON, no markdown:
{"themes":[{"name":"...","team":"Product","action":"...","reviewIndexes":[1,4,9]}]}`
}

function buildMergePrompt(sourceLines: string, sourceCount: number): string {
  return `You are a product analyst at Timeleft. Several batches of app-store reviews were clustered independently, producing ${sourceCount} overlapping themes. Consolidate them into 6-8 final themes for the leadership dashboard.

Rules:
- Merge themes that mean the same thing even if worded differently (e.g. "Subscription pricing" and "Too expensive / pricing clarity").
- Keep names specific and actionable — not vague sentiment labels.
- Prefer the clearest name and action; pick the best owning team.
- Every source id should appear in exactly one final theme's "sourceIds" when it clearly fits. Drop a source only if it is pure noise.
- Return 6-8 final themes (never more than 8).

SOURCE THEMES (id | volume | team | name — action):
${sourceLines}

Respond with ONLY valid JSON, no markdown:
{"themes":[{"name":"...","team":"Product","action":"...","sourceIds":["b0t0","b1t2"]}]}`
}

function parseBatchTaxonomy(text: string, batchLength: number, indexOffset: number): ThemeTaxonomy[] {
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    return (parsed.themes || [])
      .map((t: any): ThemeTaxonomy => {
        // Model returns 1-based indices within the batch; convert to 0-based
        // global indices into the full reviews array.
        const seen = new Set<number>()
        const reviewIndexes: number[] = []
        for (const raw of Array.isArray(t.reviewIndexes) ? t.reviewIndexes : []) {
          const local = Math.round(Number(raw)) - 1
          if (!Number.isInteger(local) || local < 0 || local >= batchLength) continue
          const idx = local + indexOffset
          if (!seen.has(idx)) {
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

function sanitizeIndexes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  const out: number[] = []
  for (const v of raw) {
    const idx = Math.round(Number(v))
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_REVIEWS || seen.has(idx)) continue
    seen.add(idx)
    out.push(idx)
  }
  return out
}

function normalizeTeam(raw: any): Team {
  const s = String(raw || '').trim().toLowerCase()
  const match = TEAMS.find(t => t.toLowerCase() === s)
  return match || 'Other'
}
