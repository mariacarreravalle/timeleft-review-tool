'use client'

import { useMemo, useState } from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { parseReviewsCsv } from './lib/parseReviews'

type Team = 'Product' | 'Tech' | 'CX & Support' | 'Ops' | 'Marketing' | 'Other'

interface Theme {
  name: string
  count: number
  percentage: number
  sentiment: number
  impact: number
  team: Team
  action: string
  quotes: string[]
}

interface AnalysisResult {
  totalReviews: number
  sentiment: { negative: number; neutral: number; positive: number; unrated: number }
  themes: Theme[]
  overallRatings: Array<{ rating: number; count: number }>
  volumeOverTime: Array<{ date: string; count: number }>
}

type SentimentFilter = 'all' | 'negative' | 'neutral' | 'positive'
type TeamFilter = 'all' | Team

const TEAMS: Team[] = ['Product', 'Tech', 'CX & Support', 'Ops', 'Marketing', 'Other']

const TEAM_DOT: Record<Team, string> = {
  Product: '#F97709',
  Tech: '#0078A8',
  'CX & Support': '#3E9C8F',
  Ops: '#B5794A',
  Marketing: '#7A5CA0',
  Other: '#958F8C',
}

const SENTIMENT_COLORS = { negative: '#C4462F', neutral: '#B8AE9C', positive: '#4F7A5B' }

function sentimentBucket(s: number): 'negative' | 'neutral' | 'positive' {
  if (s < -0.15) return 'negative'
  if (s > 0.15) return 'positive'
  return 'neutral'
}

function sentimentEmoji(s: number) {
  const b = sentimentBucket(s)
  return b === 'positive' ? '😊' : b === 'negative' ? '😞' : '😐'
}

export default function Home() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<AnalysisResult | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [parseInfo, setParseInfo] = useState('')

  // dashboard controls
  const [search, setSearch] = useState('')
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>('all')
  const [teamFilter, setTeamFilter] = useState<TeamFilter>('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [activeSlackTeam, setActiveSlackTeam] = useState<Team | null>(null)
  const [copied, setCopied] = useState(false)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) {
      setFile(f)
      setError('')
    }
  }

  const handleAnalyze = async () => {
    if (!file) {
      setError('Please select a CSV file')
      return
    }
    setLoading(true)
    setError('')

    try {
      const text = await file.text()
      const { reviews, detectedColumns, totalRows } = parseReviewsCsv(text)

      if (reviews.length === 0 || (!detectedColumns.reviewText && !detectedColumns.translatedText)) {
        setError('No review text found. Make sure the CSV has a column like "Review", "Comment", or "Feedback".')
        setLoading(false)
        return
      }

      setParseInfo(
        `Parsed ${reviews.length} of ${totalRows} rows · text: "${detectedColumns.translatedText || detectedColumns.reviewText}"` +
        (detectedColumns.rating ? ` · rating: "${detectedColumns.rating}"` : '') +
        (detectedColumns.date ? ` · date: "${detectedColumns.date}"` : '')
      )

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews })
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || `Analysis failed (HTTP ${response.status})`)
      }
      setResults(await response.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  const resetAll = () => {
    setResults(null)
    setFile(null)
    setSearch('')
    setSentimentFilter('all')
    setTeamFilter('all')
    setExpanded(null)
    setActiveSlackTeam(null)
  }

  const filteredThemes = useMemo(() => {
    if (!results) return []
    const q = search.trim().toLowerCase()
    return results.themes.filter(t => {
      if (sentimentFilter !== 'all' && sentimentBucket(t.sentiment) !== sentimentFilter) return false
      if (teamFilter !== 'all' && t.team !== teamFilter) return false
      if (q) {
        const hay = (t.name + ' ' + t.action + ' ' + t.team + ' ' + t.quotes.join(' ')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [results, search, sentimentFilter, teamFilter])

  return (
    <main className="min-h-screen bg-cream">
      {!results ? (
        <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10">
          <div className="text-center mb-8">
            <div className="flex items-baseline justify-center gap-2">
              <span className="text-2xl font-extrabold tracking-tight text-ink">Timeleft</span>
              <span className="text-2xl font-medium text-muted-dark">Review Analyzer</span>
            </div>
            <p className="text-muted-dark mt-1">
              Upload app store reviews → instant, evidence-backed clarity for Ops, Product &amp; Growth.
            </p>
          </div>
          <UploadCard
            file={file}
            error={error}
            parseInfo={parseInfo}
            loading={loading}
            onFileChange={handleFileChange}
            onAnalyze={handleAnalyze}
          />
        </div>
      ) : (
        <div className="max-w-6xl mx-auto px-6 py-10">
          <div className="flex items-center justify-between mb-8">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-extrabold tracking-tight text-ink">Timeleft</span>
                <span className="text-2xl font-medium text-muted-dark">Review Analyzer</span>
              </div>
              <p className="text-muted-dark mt-1">
                Upload app store reviews → instant, evidence-backed clarity for Ops, Product &amp; Growth.
              </p>
            </div>
            <button onClick={resetAll} className="rounded-pill bg-ink text-cream font-semibold text-sm px-5 py-2.5 hover:bg-black transition">
              ← New upload
            </button>
          </div>
          <Dashboard
            results={results}
            filteredThemes={filteredThemes}
            search={search}
            setSearch={setSearch}
            sentimentFilter={sentimentFilter}
            setSentimentFilter={setSentimentFilter}
            teamFilter={teamFilter}
            setTeamFilter={setTeamFilter}
            expanded={expanded}
            setExpanded={setExpanded}
            activeSlackTeam={activeSlackTeam}
            setActiveSlackTeam={setActiveSlackTeam}
            copied={copied}
            setCopied={setCopied}
          />
        </div>
      )}
    </main>
  )
}

/* ---------- Upload ---------- */

function UploadCard(props: {
  file: File | null
  error: string
  parseInfo: string
  loading: boolean
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onAnalyze: () => void
}) {
  const { file, error, parseInfo, loading, onFileChange, onAnalyze } = props
  return (
    <div className="bg-white rounded-3xl border border-tan p-10 w-full max-w-2xl">
      <div className="border-2 border-dashed border-tan rounded-2xl p-10 text-center hover:border-accent transition">
        <input type="file" accept=".csv" onChange={onFileChange} className="hidden" id="csv-input" />
        <label htmlFor="csv-input" className="cursor-pointer block">
          <div className="text-5xl mb-4">📊</div>
          <p className="text-lg font-semibold text-ink mb-2">{file ? file.name : 'Drag & drop CSV, or click to select'}</p>
          <p className="text-sm text-muted-dark">Needs: Review / Translated review, Rating, Submission date</p>
        </label>
      </div>

      {error && <p className="text-red-600 mt-4 text-center font-medium">{error}</p>}
      {parseInfo && !error && !loading && <p className="text-xs text-muted-dark mt-4 text-center">✓ {parseInfo}</p>}

      {loading ? (
        <div className="mt-6 rounded-2xl border border-tan bg-cream p-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-2">
            <span className="inline-block h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            <span className="font-semibold text-ink">Analysing your reviews…</span>
          </div>
          <p className="text-sm text-muted-dark">Classifying every review into themes, scoring sentiment &amp; urgency. Usually 15–25 seconds.</p>
          {parseInfo && <p className="text-xs text-muted-dark mt-3">✓ {parseInfo}</p>}
        </div>
      ) : (
        <button
          onClick={onAnalyze}
          disabled={!file}
          className="w-full mt-6 rounded-pill bg-ink hover:bg-black disabled:bg-muted disabled:cursor-not-allowed text-cream font-semibold py-3.5 px-6 transition"
        >
          Analyze reviews
        </button>
      )}
    </div>
  )
}

/* ---------- Dashboard ---------- */

function Dashboard(props: {
  results: AnalysisResult
  filteredThemes: Theme[]
  search: string
  setSearch: (s: string) => void
  sentimentFilter: SentimentFilter
  setSentimentFilter: (s: SentimentFilter) => void
  teamFilter: TeamFilter
  setTeamFilter: (t: TeamFilter) => void
  expanded: number | null
  setExpanded: (n: number | null) => void
  activeSlackTeam: Team | null
  setActiveSlackTeam: (t: Team | null) => void
  copied: boolean
  setCopied: (b: boolean) => void
}) {
  const {
    results, filteredThemes, search, setSearch, sentimentFilter, setSentimentFilter,
    teamFilter, setTeamFilter, expanded, setExpanded, activeSlackTeam, setActiveSlackTeam, copied, setCopied,
  } = props

  const total = results.totalReviews
  const topUrgent = results.themes[0] // already ranked by impact
  const rated = results.sentiment.negative + results.sentiment.neutral + results.sentiment.positive

  return (
    <div className="space-y-6">
      {/* A. Flash metric row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MetricCard label="Reviews processed">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-extrabold text-ink">{total.toLocaleString()}</span>
            <span className="text-sm text-muted-dark">reviews</span>
          </div>
          <p className="text-xs text-muted-dark mt-2">{results.themes.length} themes identified</p>
        </MetricCard>

        <MetricCard label="Sentiment (from star ratings)">
          <SentimentBar breakdown={results.sentiment} rated={rated} />
        </MetricCard>

        <MetricCard label="Most urgent issue">
          {topUrgent ? (
            <div>
              <p className="font-semibold text-ink leading-tight">{topUrgent.name}</p>
              <p className="text-sm text-muted-dark mt-1">
                <span className="text-accent font-bold">{topUrgent.percentage}%</span> of reviews · {topUrgent.count}/{total}
              </p>
              <div className="mt-2 h-1.5 rounded-full bg-tan overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.round(topUrgent.impact * 100)}%` }} />
              </div>
              <p className="text-[11px] text-muted-dark mt-1">urgency {Math.round(topUrgent.impact * 100)}/100 · owner: {topUrgent.team}</p>
            </div>
          ) : <p className="text-muted-dark">—</p>}
        </MetricCard>
      </div>

      {/* B. Controls + theme dashboard */}
      <div className="bg-white rounded-3xl border border-tan p-7">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <div>
            <h2 className="text-xl font-bold text-ink">Themes, ranked by impact</h2>
            <p className="text-sm text-muted-dark">Volume × sentiment × urgency. Click a theme for the exact quotes behind it.</p>
            <p className="text-xs text-muted mt-1">Themes are multi-label — a review can mention more than one, so shares don&apos;t sum to 100%. Counts are AI-classified across all reviews.</p>
          </div>
        </div>

        {/* search + filters */}
        <div className="flex flex-col gap-3 mt-4 mb-5">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search themes, quotes, actions…"
            className="w-full rounded-pill border border-tan bg-cream px-5 py-2.5 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent"
          />
          <div className="flex flex-wrap gap-4">
            <FilterGroup
              label="Sentiment"
              value={sentimentFilter}
              onChange={v => setSentimentFilter(v as SentimentFilter)}
              options={[['all', 'All'], ['negative', 'Negative'], ['neutral', 'Neutral'], ['positive', 'Positive']]}
            />
            <FilterGroup
              label="Team"
              value={teamFilter}
              onChange={v => setTeamFilter(v as TeamFilter)}
              options={[['all', 'All'], ...TEAMS.map(t => [t, t] as [string, string])]}
            />
          </div>
        </div>

        {filteredThemes.length === 0 ? (
          <p className="text-sm text-muted-dark py-6 text-center">No themes match these filters.</p>
        ) : (
          <div className="space-y-3">
            {filteredThemes.map((theme) => {
              // rank by position in the full ranked list
              const rank = results.themes.indexOf(theme) + 1
              const isOpen = expanded === rank
              return (
                <ThemeRow
                  key={theme.name}
                  theme={theme}
                  rank={rank}
                  total={total}
                  isOpen={isOpen}
                  onToggle={() => setExpanded(isOpen ? null : rank)}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-3xl border border-tan p-7">
          <h3 className="font-bold text-ink mb-4">Rating distribution</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={results.overallRatings}>
              <CartesianGrid strokeDasharray="3 3" stroke="#DED7CA" />
              <XAxis dataKey="rating" stroke="#666362" />
              <YAxis stroke="#666362" />
              <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #DED7CA' }} />
              <Bar dataKey="count" fill="#F97709" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-3xl border border-tan p-7">
          <h3 className="font-bold text-ink mb-4">Review volume over time</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={results.volumeOverTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="#DED7CA" />
              <XAxis dataKey="date" stroke="#666362" />
              <YAxis stroke="#666362" />
              <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #DED7CA' }} />
              <Line type="monotone" dataKey="count" stroke="#0078A8" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* C. Action plan by team */}
      <TeamActions
        themes={results.themes}
        total={total}
        activeSlackTeam={activeSlackTeam}
        setActiveSlackTeam={setActiveSlackTeam}
        copied={copied}
        setCopied={setCopied}
      />
    </div>
  )
}

function MetricCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-3xl border border-tan p-6">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-dark mb-3">{label}</p>
      {children}
    </div>
  )
}

function SentimentBar({ breakdown, rated }: { breakdown: AnalysisResult['sentiment']; rated: number }) {
  const pct = (n: number) => (rated > 0 ? Math.round((n / rated) * 100) : 0)
  const segs: Array<[keyof typeof SENTIMENT_COLORS, number]> = [
    ['negative', breakdown.negative],
    ['neutral', breakdown.neutral],
    ['positive', breakdown.positive],
  ]
  return (
    <div>
      <div className="flex h-4 rounded-full overflow-hidden bg-tan">
        {segs.map(([k, n]) => (
          <div key={k} style={{ width: `${pct(n)}%`, backgroundColor: SENTIMENT_COLORS[k] }} title={`${k}: ${n}`} />
        ))}
      </div>
      <div className="flex justify-between mt-2 text-xs">
        <span style={{ color: SENTIMENT_COLORS.negative }} className="font-semibold">😞 {pct(breakdown.negative)}%</span>
        <span className="text-muted-dark font-semibold">😐 {pct(breakdown.neutral)}%</span>
        <span style={{ color: SENTIMENT_COLORS.positive }} className="font-semibold">😊 {pct(breakdown.positive)}%</span>
      </div>
    </div>
  )
}

function FilterGroup({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<[string, string]>
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-dark">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([val, lab]) => (
          <button
            key={val}
            onClick={() => onChange(val)}
            className={`rounded-pill px-3 py-1 text-xs font-semibold transition border ${
              value === val ? 'bg-ink text-cream border-ink' : 'bg-white text-muted-dark border-tan hover:border-accent'
            }`}
          >
            {lab}
          </button>
        ))}
      </div>
    </div>
  )
}

function ThemeRow({ theme, rank, total, isOpen, onToggle }: {
  theme: Theme
  rank: number
  total: number
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <div className="rounded-2xl border border-tan overflow-hidden">
      <button onClick={onToggle} className="w-full text-left p-5 hover:bg-cream transition flex gap-4 items-start">
        <span className="text-lg font-extrabold text-muted w-6 shrink-0">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-ink">{theme.name}</span>
            <TeamBadge team={theme.team} />
            <span className="text-sm">{sentimentEmoji(theme.sentiment)}</span>
          </div>
          {/* Evidence sentence — the quantitative "why" */}
          <p className="text-sm text-muted-dark mt-1">
            <span className="font-semibold text-ink">{theme.percentage}% of reviewers mention this</span> ({theme.count} of {total}) — {theme.action || 'flagged this theme'}
          </p>
          {/* impact bar */}
          <div className="mt-2 h-1.5 rounded-full bg-tan overflow-hidden max-w-xs">
            <div className="h-full bg-accent" style={{ width: `${Math.round(theme.impact * 100)}%` }} />
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-2xl font-extrabold text-accent">{Math.round(theme.impact * 100)}</p>
          <p className="text-[11px] text-muted-dark">impact</p>
          <p className="text-[11px] text-accent mt-1">{isOpen ? 'Hide quotes ▲' : 'Show quotes ▼'}</p>
        </div>
      </button>

      {isOpen && (
        <div className="px-5 pb-5 pt-1 bg-cream border-t border-tan">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-dark mb-2">Top quotes backing this theme</p>
          <div className="space-y-2">
            {theme.quotes.length > 0 ? theme.quotes.slice(0, 3).map((q, i) => (
              <blockquote key={i} className="text-sm text-ink italic border-l-2 border-accent pl-3">
                “{q}”
              </blockquote>
            )) : <p className="text-sm text-muted-dark">No quotes returned for this theme.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function TeamBadge({ team }: { team: Team }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-cream border border-tan px-2.5 py-0.5 text-xs font-semibold text-ink">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TEAM_DOT[team] }} />
      {team}
    </span>
  )
}

function TeamActions({ themes, total, activeSlackTeam, setActiveSlackTeam, copied, setCopied }: {
  themes: Theme[]
  total: number
  activeSlackTeam: Team | null
  setActiveSlackTeam: (t: Team | null) => void
  copied: boolean
  setCopied: (b: boolean) => void
}) {
  const byTeam = TEAMS
    .map(team => ({ team, items: themes.filter(t => t.team === team) }))
    .filter(g => g.items.length > 0)

  return (
    <div className="bg-white rounded-3xl border border-tan p-7">
      <h2 className="text-xl font-bold text-ink mb-1">Action plan by team</h2>
      <p className="text-sm text-muted-dark mb-5">
        Delegate each theme to its owner. Draft a Slack update per team, or wire the same payload into a MAKE scenario for a recurring digest.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {byTeam.map(({ team, items }) => (
          <div key={team} className="rounded-2xl border border-tan p-5">
            <div className="flex items-center justify-between mb-3">
              <TeamBadge team={team} />
              <span className="text-xs text-muted-dark">{items.length} {items.length === 1 ? 'theme' : 'themes'}</span>
            </div>
            <ul className="space-y-2 mb-4">
              {items.map(t => (
                <li key={t.name} className="text-sm">
                  <span className="font-semibold text-ink">{t.name}</span>
                  <span className="text-muted-dark"> — {t.percentage}% · </span>
                  <span className="text-ink">{t.action || 'review flagged theme'}</span>
                </li>
              ))}
            </ul>
            <button
              onClick={() => { setActiveSlackTeam(activeSlackTeam === team ? null : team); setCopied(false) }}
              className="rounded-pill bg-accent hover:bg-orange-600 text-white font-semibold py-2 px-4 text-sm transition"
            >
              {activeSlackTeam === team ? 'Hide Slack draft' : `Draft Slack for ${team}`}
            </button>

            {activeSlackTeam === team && (
              <div className="mt-3">
                <div className="bg-ink rounded-2xl p-4 font-mono text-xs text-cream whitespace-pre-wrap max-h-56 overflow-y-auto">
                  {buildTeamSlack(team, items, total)}
                </div>
                <button
                  onClick={() => { navigator.clipboard.writeText(buildTeamSlack(team, items, total)); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                  className="mt-2 rounded-pill bg-ink text-cream font-semibold py-1.5 px-4 text-xs hover:bg-black transition"
                >
                  {copied ? 'Copied ✓' : 'Copy to clipboard'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function buildTeamSlack(team: Team, themes: Theme[], total: number): string {
  const lines = [`*📋 Timeleft review digest — ${team}*`, `_${total} reviews analysed_`, '']
  themes.forEach((t, i) => {
    lines.push(`${i + 1}. *${t.name}* — ${t.percentage}% of reviews (${t.count}/${total})`)
    if (t.action) lines.push(`   →  ${t.action}`)
    if (t.quotes[0]) lines.push(`   💬 "${t.quotes[0].slice(0, 120)}"`)
    lines.push('')
  })
  lines.push('→ Full dashboard: [link]')
  return lines.join('\n')
}
