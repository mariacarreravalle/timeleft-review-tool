import { NextRequest, NextResponse } from 'next/server'

// Vercel kills serverless functions at 10s by default (Hobby plan). The Claude
// call can take 10-30s, so raise the ceiling or the request 504s in production.
export const maxDuration = 60
export const runtime = 'nodejs'

// Model is env-overridable. Default to Sonnet: theme extraction over ~50 review
// snippets doesn't need Opus, and Sonnet cuts the wait roughly in half.
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'claude-sonnet-5'

interface Review {
  date: string
  rating: number
  text: string
}

interface Theme {
  name: string
  volume: number
  sentiment: number
  severity: number
  quotes: string[]
  trend: number
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

    // Call Claude to extract themes and sentiment
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
        // This is a structured JSON extraction, not a reasoning task — turn off
        // Sonnet 5's default adaptive thinking to cut latency and variance.
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'user',
            content: buildAnalysisPrompt(reviews)
          }
        ]
      })
    })

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text()
      console.error('Claude API error:', err)
      return NextResponse.json({ error: 'Analysis service error' }, { status: 500 })
    }

    const claudeData = await claudeResponse.json() as any
    // Don't assume content[0] is text — models with thinking on (e.g. Sonnet 5
    // by default) put a thinking block first. Grab the actual text block(s).
    const analysisText = (claudeData.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')

    // Parse Claude's response
    const themes = parseThemesFromResponse(analysisText, reviews)
    const overallRatings = buildRatingChart(reviews)
    const volumeOverTime = buildVolumeChart(reviews)
    const slackDraft = buildSlackMessage(themes)

    return NextResponse.json({
      themes,
      overallRatings,
      volumeOverTime,
      slackDraft
    })
  } catch (error) {
    console.error('Analysis error:', error)
    return NextResponse.json(
      { error: 'Analysis failed' },
      { status: 500 }
    )
  }
}

function buildAnalysisPrompt(reviews: Review[]): string {
  const sampleReviews = reviews.slice(0, 50).map(r => `"${r.text.slice(0, 200)}"`).join('\n')

  return `You are a product analyst. Analyze these app review excerpts and extract the top themes.

For each theme:
1. Name it clearly (e.g., "Pricing model complaints", "App stability issues")
2. Estimate how many reviews mention it (volume out of ${reviews.length})
3. Provide average sentiment (-1 = very negative, 0 = neutral, +1 = very positive)
4. List 2-3 representative quotes

Focus on actionable themes, not sentiment labels. E.g., "app crashes" not "bad app".

Sample reviews:
${sampleReviews}

RESPOND ONLY with valid JSON in this exact format (no markdown, no extra text):
{
  "themes": [
    {
      "name": "Theme Name",
      "volume": 45,
      "sentiment": -0.8,
      "quotes": ["exact quote from review", "another quote"]
    }
  ]
}

Extract 5-8 themes. Be specific.`
}

function parseThemesFromResponse(text: string, reviews: Review[]): Theme[] {
  try {
    // Remove markdown code blocks if present
    const cleanedText = text.replace(/```json\n?|\n?```/g, '').trim()
    const parsed = JSON.parse(cleanedText)

    return parsed.themes.map((t: any) => ({
      name: t.name,
      volume: t.volume,
      sentiment: t.sentiment,
      severity: calculateSeverity(t.volume, t.sentiment, reviews.length, t.quotes || []),
      quotes: t.quotes || [],
      trend: 0 // Would calculate if we had prior window data
    })).sort((a: Theme, b: Theme) => b.severity - a.severity)
  } catch (err) {
    console.error('Parse error:', err)
    return []
  }
}

function calculateSeverity(volume: number, sentiment: number, total: number, quotes: string[]): number {
  const volumeScore = Math.min(volume / total, 1) // 0-1
  const sentimentScore = Math.abs(sentiment) // Neutral (0) is less severe, extreme is more severe
  const urgencyKeywords = ['cancel', 'refund', 'uninstall', 'waste', 'scam', 'bug', 'crash', 'error']
  const hasUrgency = quotes.some(q => urgencyKeywords.some(kw => q.toLowerCase().includes(kw)))
  const urgencyBoost = hasUrgency ? 0.2 : 0

  return Math.min(volumeScore * 0.5 + sentimentScore * 0.3 + urgencyBoost, 1)
}

function buildRatingChart(reviews: Review[]): Array<{ rating: number; count: number }> {
  const counts: { [key: number]: number } = {}
  reviews.forEach(r => {
    if (r.rating > 0) {
      counts[r.rating] = (counts[r.rating] || 0) + 1
    }
  })

  return [1, 2, 3, 4, 5].map(rating => ({
    rating,
    count: counts[rating] || 0
  }))
}

function buildVolumeChart(reviews: Review[]): Array<{ date: string; count: number }> {
  const byDate: { [key: string]: number } = {}

  reviews.forEach(r => {
    if (r.date) {
      const date = r.date.split('T')[0] // YYYY-MM-DD
      byDate[date] = (byDate[date] || 0) + 1
    }
  })

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }))
    .slice(-30) // Last 30 days
}

function buildSlackMessage(themes: Theme[]): string {
  const lines = ['📊 *App Review Analysis*', '']

  const topIssues = themes.slice(0, 3)
  if (topIssues.length > 0) {
    lines.push('*🔥 Top 3 Issues:*')
    topIssues.forEach((t, i) => {
      lines.push(
        `${i + 1}. *${t.name}*`,
        `   • ${t.volume} ${t.volume === 1 ? 'review' : 'reviews'} • Sentiment: ${t.sentiment > 0 ? '+' : ''}${t.sentiment.toFixed(2)}`,
        t.quotes.length > 0 ? `   • "${t.quotes[0].slice(0, 100)}..."` : '',
        ''
      )
    })
  }

  lines.push('→ Full analysis: [view in dashboard]')
  return lines.join('\n')
}
