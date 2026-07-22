'use client'

import { useEffect, useMemo, useState } from 'react'
import { jsPDF } from 'jspdf'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { parseReviewsCsv, type Review } from './lib/parseReviews'
import {
  hashText, findCached, saveToCache, loadActive, saveActive, clearActive,
  type CachedAnalysis, type SavedFilters
} from './lib/persistence'

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

// Returned by the API: theme + the review indices that express it (multi-label).
interface ThemeTaxonomy {
  name: string
  team: Team
  action: string
  reviewIndexes: number[]
}

interface AnalysisResult {
  totalReviews: number
  sentiment: { negative: number; neutral: number; positive: number; unrated: number }
  themes: Theme[]
  overallRatings: Array<{ rating: number; count: number }>
  volumeOverTime: Array<{ date: string; count: number }>
  dateRange: { earliest: string; latest: string } | null
}

type SentimentFilter = 'all' | 'negative' | 'neutral' | 'positive'
type TeamFilter = 'all' | Team
type Timeframe = 'all' | '2025-09' | '2025-10' | '2025-11'

const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  all: 'All',
  '2025-09': 'Sep 25',
  '2025-10': 'Oct 25',
  '2025-11': 'Nov 25',
}

/** Prior calendar month for trend deltas (only months present in this export). */
const PRIOR_TIMEFRAME: Partial<Record<Timeframe, Timeframe>> = {
  '2025-10': '2025-09',
  '2025-11': '2025-10',
}

function normalizeTimeframe(t: string): Timeframe {
  if (t === 'all' || t === '2025-09' || t === '2025-10' || t === '2025-11') return t
  return 'all'
}

/** YYYY-MM from a review date string (prefers the literal prefix to avoid TZ shifts). */
function monthKey(dateStr: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(dateStr.trim())
  if (m) return `${m[1]}-${m[2]}`
  const t = Date.parse(dateStr)
  if (isNaN(t)) return null
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function inTimeframe(dateStr: string, timeframe: Timeframe): boolean {
  if (timeframe === 'all') return true
  return monthKey(dateStr) === timeframe
}

const TEAMS: Team[] = ['Product', 'Tech', 'CX & Support', 'Ops', 'Marketing', 'Other']

const REGION_NAMES = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null

function countryName(code: string): string {
  const c = code.trim().toUpperCase()
  if (!c) return 'Unknown region'
  try { return REGION_NAMES?.of(c) || c } catch { return c }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

// Below this many reviews in a region/slice, percentages and rankings swing a
// lot on a single review — flag it rather than presenting it with the same
// confidence as a large sample.
const REGION_SMALL_SAMPLE_MAX = 20
// A theme resting on this few reviews or fewer gets a low-confidence flag,
// especially when it's ranked as the top "Most urgent issue".
const THEME_LOW_CONFIDENCE_MAX = 2

const IMPACT_FORMULA_TOOLTIP = 'Impact = 60% volume share + 25% negativity (how negative the average rating is) + 15% bonus if quotes mention urgent language (cancel, refund, crash, charge, etc.)'

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (isNaN(ms) || ms < 0) return 'recently'
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function computeDateRange(reviews: Review[]): { earliest: string; latest: string } | null {
  const times = reviews.map(r => Date.parse(r.date)).filter(t => !isNaN(t))
  if (!times.length) return null
  return { earliest: formatDate(Math.min(...times)), latest: formatDate(Math.max(...times)) }
}

// Pick quotes close to a readable target length rather than the single
// longest text. The longest review is often a rambling multi-topic wall of
// text; something near ~120 chars usually reads as one crisp, complete point.
const QUOTE_TARGET_LENGTH = 120
function pickQuotes(texts: string[], max = 3): string[] {
  const ranked = [...texts].sort((a, b) => Math.abs(a.length - QUOTE_TARGET_LENGTH) - Math.abs(b.length - QUOTE_TARGET_LENGTH))
  return ranked.slice(0, max).map(q => (q.length > 220 ? q.slice(0, 220).trimEnd() + '…' : q))
}

// Volume-led urgency, amplified by negativity + hard-signal keywords.
function calculateImpact(count: number, sentiment: number, total: number, texts: string[]): number {
  const volumeShare = total > 0 ? count / total : 0
  const negativity = sentiment < 0 ? -sentiment : 0
  const urgencyKeywords = ['cancel', 'refund', 'uninstall', 'waste', 'scam', 'bug', 'crash', 'error', 'charge', 'unsubscribe']
  const hasUrgency = texts.some(t => urgencyKeywords.some(kw => t.toLowerCase().includes(kw)))
  return clamp(volumeShare * 0.6 + negativity * 0.25 + (hasUrgency ? 0.15 : 0), 0, 1)
}

function sentimentBreakdown(reviews: Review[]) {
  const b = { negative: 0, neutral: 0, positive: 0, unrated: 0 }
  for (const r of reviews) {
    if (r.rating >= 4) b.positive++
    else if (r.rating === 3) b.neutral++
    else if (r.rating >= 1) b.negative++
    else b.unrated++
  }
  return b
}

function ratingChart(reviews: Review[]) {
  const counts: Record<number, number> = {}
  reviews.forEach(r => { if (r.rating > 0) counts[r.rating] = (counts[r.rating] || 0) + 1 })
  return [1, 2, 3, 4, 5].map(rating => ({ rating, count: counts[rating] || 0 }))
}

function volumeChart(reviews: Review[]) {
  const byDate: Record<string, number> = {}
  reviews.forEach(r => { if (r.date) { const d = r.date.split('T')[0]; byDate[d] = (byDate[d] || 0) + 1 } })
  return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })).slice(-30)
}

// Re-slice the whole dashboard for the selected country/city, client-side.
// Themes keep the AI taxonomy but every number (count, %, sentiment, impact,
// quotes) is recomputed from the reviews that fall in the current region.
function computeView(reviews: Review[], taxonomy: ThemeTaxonomy[], country: string, city: string, timeframe: Timeframe): AnalysisResult {
  const inRegion = (r: Review) =>
    (country === 'all' || r.country === country) &&
    (city === 'all' || r.city === city) &&
    inTimeframe(r.date, timeframe)

  const regionIdx = new Set<number>()
  reviews.forEach((r, i) => { if (inRegion(r)) regionIdx.add(i) })
  const regionReviews = [...regionIdx].map(i => reviews[i])
  const total = regionReviews.length

  const themes: Theme[] = taxonomy
    .map(t => {
      const members = t.reviewIndexes.filter(i => regionIdx.has(i))
      const count = members.length
      const ratings = members.map(i => reviews[i].rating).filter(r => r >= 1)
      const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0
      const sentiment = ratings.length ? clamp((avg - 3) / 2, -1, 1) : 0
      const texts = members.map(i => reviews[i].text)
      const quotes = pickQuotes(texts)
      return {
        name: t.name,
        team: t.team,
        action: t.action,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0,
        sentiment,
        impact: calculateImpact(count, sentiment, total, texts),
        quotes
      }
    })
    .filter(t => t.count > 0)
    .sort((a, b) => b.impact - a.impact)

  return {
    totalReviews: total,
    sentiment: sentimentBreakdown(regionReviews),
    themes,
    overallRatings: ratingChart(regionReviews),
    volumeOverTime: volumeChart(regionReviews),
    dateRange: computeDateRange(regionReviews)
  }
}

interface TrendData {
  priorTotal: number
  priorCounts: Map<string, number> // theme name -> count in the prior equivalent window
}

// Compares the selected calendar month against the previous month in the
// export (Oct→Sep, Nov→Oct). Sep and "all" have no prior window.
function computeTrend(reviews: Review[], taxonomy: ThemeTaxonomy[], country: string, city: string, timeframe: Timeframe): TrendData | null {
  const prior = PRIOR_TIMEFRAME[timeframe]
  if (!prior) return null

  const inRegion = (r: Review) => (country === 'all' || r.country === country) && (city === 'all' || r.city === city)

  const priorIdx = new Set<number>()
  reviews.forEach((r, i) => {
    if (!inRegion(r) || !inTimeframe(r.date, prior)) return
    priorIdx.add(i)
  })

  const priorCounts = new Map<string, number>()
  taxonomy.forEach(t => priorCounts.set(t.name, t.reviewIndexes.filter(i => priorIdx.has(i)).length))

  return { priorTotal: priorIdx.size, priorCounts }
}

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
  const [file, setFile] = useState<File | null>(null)
  const [parseInfo, setParseInfo] = useState('')

  // analysis data: the raw parsed reviews (kept client-side for region slicing)
  // plus the AI theme taxonomy. The displayed dashboard is derived from these.
  const [reviews, setReviews] = useState<Review[]>([])
  const [taxonomy, setTaxonomy] = useState<ThemeTaxonomy[] | null>(null)
  // region controls + timeframe
  const [country, setCountry] = useState('all')
  const [timeframe, setTimeframe] = useState<Timeframe>('all')

  // dashboard controls
  const [search, setSearch] = useState('')
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>('all')
  const [teamFilter, setTeamFilter] = useState<TeamFilter>('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [activeSlackTeam, setActiveSlackTeam] = useState<Team | null>(null)
  const [copied, setCopied] = useState(false)

  // persistence: which cached analysis (by CSV hash) is currently open, and
  // whether there's a previous session on this browser worth offering to
  // resume. See app/lib/persistence.ts.
  const [activeHash, setActiveHash] = useState<string | null>(null)
  const [resumeCandidate, setResumeCandidate] = useState<{ entry: CachedAnalysis; filters: SavedFilters } | null>(null)

  // On mount, check for a resumable session from a previous visit (survives
  // a refresh) — offered, not auto-applied, so a deliberate fresh start isn't
  // silently overridden.
  useEffect(() => {
    const active = loadActive()
    if (!active) return
    const cached = findCached(active.csvHash)
    if (cached) setResumeCandidate({ entry: cached, filters: active.filters })
  }, [])

  // Keep the saved session's filters in sync with the current ones while an
  // analysis is open, so a refresh restores not just the data but the view.
  useEffect(() => {
    if (!activeHash) return
    saveActive(activeHash, { country, city: 'all', timeframe, sentimentFilter, teamFilter, search })
  }, [activeHash, country, timeframe, sentimentFilter, teamFilter, search])

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
      const csvHash = hashText(text)

      // Same file already analyzed on this browser — reuse the exact same
      // taxonomy instead of re-clustering. This is what makes repeat uploads
      // of the same export comparable rather than independently reworded.
      const cached = findCached(csvHash)
      if (cached) {
        setReviews(cached.reviews)
        setTaxonomy(cached.taxonomy as ThemeTaxonomy[])
        setCountry('all')
        setTimeframe('all')
        setActiveHash(csvHash)
        saveActive(csvHash, { country: 'all', city: 'all', timeframe: 'all', sentimentFilter: 'all', teamFilter: 'all', search: '' })
        setParseInfo(`✓ Recognized this exact file from a previous analysis (${cached.reviews.length} reviews, analyzed ${formatRelativeTime(cached.analyzedAt)}) — reused instantly, no re-analysis needed.`)
        setResumeCandidate(null)
        setLoading(false)
        return
      }

      const { reviews: parsedReviews, detectedColumns, totalRows } = parseReviewsCsv(text)

      if (parsedReviews.length === 0 || (!detectedColumns.reviewText && !detectedColumns.translatedText)) {
        setError('No review text found. Make sure the CSV has a column like "Review", "Comment", or "Feedback".')
        setLoading(false)
        return
      }

      setParseInfo(
        `Parsed ${parsedReviews.length} of ${totalRows} rows · text: "${detectedColumns.translatedText || detectedColumns.reviewText}"` +
        (detectedColumns.rating ? ` · rating: "${detectedColumns.rating}"` : '') +
        (detectedColumns.country ? ` · country: "${detectedColumns.country}"` : '')
      )

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews: parsedReviews })
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || `Analysis failed (HTTP ${response.status})`)
      }
      const data = await response.json() as { themes: ThemeTaxonomy[] }
      setReviews(parsedReviews)
      setTaxonomy(data.themes)
      setCountry('all')
      setTimeframe('all')

      saveToCache({
        csvHash,
        filename: file.name,
        analyzedAt: new Date().toISOString(),
        reviews: parsedReviews,
        taxonomy: data.themes,
        hasCityData: !!detectedColumns.city
      })
      setActiveHash(csvHash)
      saveActive(csvHash, { country: 'all', city: 'all', timeframe: 'all', sentimentFilter: 'all', teamFilter: 'all', search: '' })
      setResumeCandidate(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  const resumeSession = () => {
    if (!resumeCandidate) return
    const { entry, filters } = resumeCandidate
    setReviews(entry.reviews)
    setTaxonomy(entry.taxonomy as ThemeTaxonomy[])
    setCountry(filters.country)
    setTimeframe(normalizeTimeframe(filters.timeframe))
    setSentimentFilter(filters.sentimentFilter as SentimentFilter)
    setTeamFilter(filters.teamFilter as TeamFilter)
    setSearch(filters.search)
    setActiveHash(entry.csvHash)
    setParseInfo(`✓ Resumed previous analysis (${entry.reviews.length} reviews, analyzed ${formatRelativeTime(entry.analyzedAt)}).`)
    setResumeCandidate(null)
  }

  const dismissResume = () => {
    clearActive()
    setResumeCandidate(null)
  }

  const resetAll = () => {
    setReviews([])
    setTaxonomy(null)
    setFile(null)
    setSearch('')
    setSentimentFilter('all')
    setTeamFilter('all')
    setExpanded(null)
    setActiveSlackTeam(null)
    setCountry('all')
    setTimeframe('all')
    setActiveHash(null)
    clearActive()
  }

  // Country list (non-empty, by volume).
  const countries = useMemo(() => {
    const map = new Map<string, number>()
    reviews.forEach(r => { if (r.country) map.set(r.country, (map.get(r.country) || 0) + 1) })
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [reviews])

  // The entire dashboard is derived from this region-sliced view.
  const view = useMemo(
    () => (taxonomy ? computeView(reviews, taxonomy, country, 'all', timeframe) : null),
    [taxonomy, reviews, country, timeframe]
  )

  // Prior-period comparison for the same region, only meaningful once a
  // specific timeframe window is picked (see computeTrend).
  const trend = useMemo(
    () => (taxonomy ? computeTrend(reviews, taxonomy, country, 'all', timeframe) : null),
    [taxonomy, reviews, country, timeframe]
  )

  const filteredThemes = useMemo(() => {
    if (!view) return []
    const q = search.trim().toLowerCase()
    return view.themes.filter(t => {
      if (sentimentFilter !== 'all' && sentimentBucket(t.sentiment) !== sentimentFilter) return false
      if (teamFilter !== 'all' && t.team !== teamFilter) return false
      if (q) {
        const hay = (t.name + ' ' + t.action + ' ' + t.team + ' ' + t.quotes.join(' ')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [view, search, sentimentFilter, teamFilter])

  const onCountryChange = (c: string) => { setCountry(c); setExpanded(null) }

  return (
    <main className="min-h-screen bg-cream">
      {!view ? (
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
          {resumeCandidate && (
            <div className="w-full max-w-2xl mb-4 rounded-2xl border border-tan bg-white p-5 flex items-center justify-between gap-4">
              <div>
                <p className="font-semibold text-ink">Resume your last analysis?</p>
                <p className="text-sm text-muted-dark">
                  {resumeCandidate.entry.filename} · {resumeCandidate.entry.reviews.length} reviews · analyzed {formatRelativeTime(resumeCandidate.entry.analyzedAt)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={dismissResume} className="text-sm font-semibold text-muted-dark hover:text-ink transition px-3 py-2">
                  Start fresh
                </button>
                <button onClick={resumeSession} className="rounded-pill bg-ink text-cream font-semibold text-sm px-5 py-2.5 hover:bg-black transition">
                  Resume
                </button>
              </div>
            </div>
          )}
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
            <div className="flex items-center gap-2">
              <ExportReportButton
                results={view}
                filteredThemes={filteredThemes}
                trend={trend}
                regionLabel={`${country === 'all' ? 'All countries' : countryName(country)} · ${TIMEFRAME_LABEL[timeframe]}`}
              />
              <button onClick={resetAll} className="rounded-pill bg-ink text-cream font-semibold text-sm px-5 py-2.5 hover:bg-black transition">
                ← New upload
              </button>
            </div>
          </div>

          <RegionFilter
            countries={countries}
            country={country}
            onCountryChange={onCountryChange}
            timeframe={timeframe}
            setTimeframe={t => { setTimeframe(t); setExpanded(null) }}
            totalAll={reviews.length}
            totalRegion={view.totalReviews}
          />

          <Dashboard
            results={view}
            filteredThemes={filteredThemes}
            trend={trend}
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

/* ---------- Region filter ---------- */

function RegionFilter(props: {
  countries: Array<[string, number]>
  country: string
  onCountryChange: (c: string) => void
  timeframe: Timeframe
  setTimeframe: (t: Timeframe) => void
  totalAll: number
  totalRegion: number
}) {
  const { countries, country, onCountryChange, timeframe, setTimeframe, totalAll, totalRegion } = props

  return (
    <div className="bg-white rounded-3xl border border-tan p-5 mb-6">
      <div className="flex flex-col md:flex-row md:items-end gap-4">
        <div className="flex-1">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-1.5">Country / market</label>
          <select
            value={country}
            onChange={e => onCountryChange(e.target.value)}
            className="w-full rounded-pill border border-tan bg-cream px-5 py-2.5 text-sm font-semibold text-ink focus:outline-none focus:border-accent cursor-pointer"
          >
            <option value="all">All countries ({totalAll})</option>
            {countries.map(([code, count]) => (
              <option key={code} value={code}>{countryName(code)} ({count})</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-1.5">Timeframe</label>
          <FilterGroup
            label=""
            value={timeframe}
            onChange={v => setTimeframe(v as Timeframe)}
            options={[['all', 'All'], ['2025-09', 'Sep 25'], ['2025-10', 'Oct 25'], ['2025-11', 'Nov 25']]}
          />
        </div>

        <div className="md:pb-2 md:text-right">
          <p className="text-xs text-muted-dark">Showing</p>
          <p className="text-lg font-extrabold text-ink leading-tight">
            {totalRegion.toLocaleString()}<span className="text-sm font-medium text-muted-dark"> / {totalAll.toLocaleString()}</span>
          </p>
          <p className="text-[11px] text-muted-dark">
            {country === 'all' ? 'all markets' : countryName(country)} · {TIMEFRAME_LABEL[timeframe]}
          </p>
        </div>
      </div>
    </div>
  )
}

/* ---------- Dashboard ---------- */

function Dashboard(props: {
  results: AnalysisResult
  filteredThemes: Theme[]
  trend: TrendData | null
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
    results, filteredThemes, trend, search, setSearch, sentimentFilter, setSentimentFilter,
    teamFilter, setTeamFilter, expanded, setExpanded, activeSlackTeam, setActiveSlackTeam, copied, setCopied,
  } = props

  const total = results.totalReviews
  const topUrgent = results.themes[0] // already ranked by impact
  const rated = results.sentiment.negative + results.sentiment.neutral + results.sentiment.positive
  const volumeDelta = trend && trend.priorTotal > 0 ? total - trend.priorTotal : null

  return (
    <div className="space-y-6">
      {total > 0 && total < REGION_SMALL_SAMPLE_MAX && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-3 text-sm text-amber-900">
          <span className="font-semibold">⚠ Small sample ({total} reviews in this view).</span> Percentages and rankings can swing a lot with each new review — treat as directional, not definitive.
        </div>
      )}

      {/* A. Flash metric row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <MetricCard label="Reviews processed">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-extrabold text-ink">{total.toLocaleString()}</span>
            <span className="text-sm text-muted-dark">reviews</span>
          </div>
          <p className="text-xs text-muted-dark mt-2">{results.themes.length} themes identified</p>
          {results.dateRange && (
            <p className="text-[11px] text-muted mt-1">{results.dateRange.earliest} – {results.dateRange.latest}</p>
          )}
          {trend && (
            <p className="text-[11px] font-semibold mt-1">
              {volumeDelta === null ? (
                <span className="text-muted-dark">No prior-period data to compare</span>
              ) : (
                <span className={volumeDelta > 0 ? 'text-accent' : volumeDelta < 0 ? 'text-info' : 'text-muted-dark'}>
                  {volumeDelta > 0 ? '▲' : volumeDelta < 0 ? '▼' : '–'} {volumeDelta === 0 ? 'no change' : `${volumeDelta > 0 ? '+' : ''}${volumeDelta}`} vs prior equivalent period
                </span>
              )}
            </p>
          )}
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
              <p className="text-[11px] text-muted-dark mt-1" title={IMPACT_FORMULA_TOOLTIP}>
                urgency {Math.round(topUrgent.impact * 100)}/100 ⓘ · owner: {topUrgent.team}
              </p>
              {topUrgent.count <= THEME_LOW_CONFIDENCE_MAX && (
                <p className="text-[11px] text-amber-700 font-semibold mt-1">⚠ Based on very few reviews ({topUrgent.count}) — treat as directional, not definitive.</p>
              )}
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
              const priorCount = trend && trend.priorTotal > 0 ? trend.priorCounts.get(theme.name) ?? 0 : null
              const trendDelta = priorCount === null ? null : theme.count - priorCount
              return (
                <ThemeRow
                  key={theme.name}
                  theme={theme}
                  rank={rank}
                  total={total}
                  isOpen={isOpen}
                  onToggle={() => setExpanded(isOpen ? null : rank)}
                  trendDelta={trendDelta}
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
        trend={trend}
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
      {label && <span className="text-xs font-semibold uppercase tracking-wide text-muted-dark">{label}</span>}
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

function ThemeRow({ theme, rank, total, isOpen, onToggle, trendDelta }: {
  theme: Theme
  rank: number
  total: number
  isOpen: boolean
  onToggle: () => void
  trendDelta: number | null
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
            {theme.count <= THEME_LOW_CONFIDENCE_MAX && (
              <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-pill px-2 py-0.5 font-semibold">
                ⚠ low sample (n={theme.count})
              </span>
            )}
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
        <div className="text-right shrink-0" title={IMPACT_FORMULA_TOOLTIP}>
          <p className="text-2xl font-extrabold text-accent">{Math.round(theme.impact * 100)}</p>
          <p className="text-[11px] text-muted-dark">impact ⓘ</p>
          {trendDelta !== null && (
            <p className={`text-[11px] font-semibold mt-0.5 ${trendDelta > 0 ? 'text-accent' : trendDelta < 0 ? 'text-info' : 'text-muted-dark'}`}>
              {trendDelta > 0 ? '▲' : trendDelta < 0 ? '▼' : '–'} {trendDelta === 0 ? 'no change' : `${trendDelta > 0 ? '+' : ''}${trendDelta} vs prior`}
            </p>
          )}
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

function TeamActions({ themes, total, trend, activeSlackTeam, setActiveSlackTeam, copied, setCopied }: {
  themes: Theme[]
  total: number
  trend: TrendData | null
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
                  {buildTeamSlack(team, items, total, trend)}
                </div>
                <button
                  onClick={() => { navigator.clipboard.writeText(buildTeamSlack(team, items, total, trend)); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
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

/* ---------- Export report (PDF / Slack / email) ---------- */

function ExportReportButton({ results, filteredThemes, trend, regionLabel }: {
  results: AnalysisResult
  filteredThemes: Theme[]
  trend: TrendData | null
  regionLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const flash = (msg: string) => {
    setStatus(msg)
    setOpen(false)
    setTimeout(() => setStatus(null), 2000)
  }

  const exportPdf = () => {
    try {
      downloadReportPdf(regionLabel, results, filteredThemes, trend)
      flash('PDF downloaded ✓')
    } catch {
      flash('PDF export failed')
    }
  }

  const copySlack = async () => {
    await navigator.clipboard.writeText(buildSlackReport(regionLabel, results, filteredThemes, trend))
    flash('Slack message copied ✓')
  }

  const copyEmail = async () => {
    await navigator.clipboard.writeText(buildEmailReport(regionLabel, results, filteredThemes, trend))
    flash('Email message copied ✓')
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="rounded-pill bg-white border border-tan text-ink font-semibold text-sm px-5 py-2.5 hover:border-accent transition"
      >
        {status || (open ? 'Export ▲' : 'Export ▼')}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close export menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full mt-2 z-20 w-60 rounded-2xl border border-tan bg-white py-1.5 shadow-lg">
            <ExportMenuItem label="Export as PDF" onClick={exportPdf} />
            <ExportMenuItem label="Export as Slack message" onClick={copySlack} />
            <ExportMenuItem label="Export as email message" onClick={copyEmail} />
          </div>
        </>
      )}
    </div>
  )
}

function ExportMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-2.5 text-sm font-semibold text-ink hover:bg-cream transition"
    >
      {label}
    </button>
  )
}

function reportPct(results: AnalysisResult) {
  const rated = results.sentiment.negative + results.sentiment.neutral + results.sentiment.positive
  return (n: number) => (rated > 0 ? Math.round((n / rated) * 100) : 0)
}

function buildFullReport(regionLabel: string, results: AnalysisResult, filteredThemes: Theme[], trend: TrendData | null): string {
  const pct = reportPct(results)

  const lines: string[] = []
  lines.push(`Timeleft Review Analysis — ${regionLabel}`)
  if (results.dateRange) lines.push(`Data period: ${results.dateRange.earliest} – ${results.dateRange.latest}`)
  lines.push('')
  lines.push(`Reviews processed: ${results.totalReviews}`)
  if (trend) {
    if (trend.priorTotal > 0) {
      const delta = results.totalReviews - trend.priorTotal
      lines.push(`  vs prior equivalent period: ${delta >= 0 ? '+' : ''}${delta} (was ${trend.priorTotal})`)
    } else {
      lines.push('  vs prior equivalent period: no comparable data')
    }
  }
  lines.push(`Sentiment: ${pct(results.sentiment.negative)}% negative, ${pct(results.sentiment.neutral)}% neutral, ${pct(results.sentiment.positive)}% positive (from star ratings)`)
  lines.push('')
  lines.push(`Themes shown (${filteredThemes.length} of ${results.themes.length} total, ranked by impact):`)
  lines.push('')
  filteredThemes.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.name} [${t.team}]`)
    lines.push(`   ${t.percentage}% of reviewers mention this (${t.count} of ${results.totalReviews}) · impact ${Math.round(t.impact * 100)}/100`)
    if (trend && trend.priorTotal > 0) {
      const priorCount = trend.priorCounts.get(t.name) ?? 0
      const delta = t.count - priorCount
      lines.push(`   vs prior period: ${delta >= 0 ? '+' : ''}${delta}`)
    }
    if (t.count <= THEME_LOW_CONFIDENCE_MAX) lines.push(`   ⚠ Based on very few reviews (${t.count}) — treat as directional.`)
    if (t.action) lines.push(`   Action: ${t.action}`)
    if (t.quotes[0]) lines.push(`   Quote: "${t.quotes[0]}"`)
    lines.push('')
  })

  return lines.join('\n')
}

function buildEmailReport(regionLabel: string, results: AnalysisResult, filteredThemes: Theme[], trend: TrendData | null): string {
  return [
    `Subject: Timeleft review analysis — ${regionLabel}`,
    '',
    buildFullReport(regionLabel, results, filteredThemes, trend),
    '',
    '—',
    'Sent from Timeleft Review Analyzer',
  ].join('\n')
}

// --- Decision-first framing for the Slack outputs (per-team and whole-view) ---
// Slack messages here lead with a declarative headline ("X is the #1 issue
// right now, up from Y") plus an explicit "Decide:" line, rather than opening
// with metrics/metadata the reader has to interpret themselves. Deltas are
// stated as absolute counts ("up from 54"), not percentages, since percentage
// swings on small counts read as more dramatic than they are.

function themeNoun(sentiment: number): string {
  if (sentiment < -0.15) return 'complaint'
  if (sentiment > 0.15) return 'highlight'
  return 'theme'
}

function priorityEmoji(sentiment: number): string {
  if (sentiment < -0.15) return '🔴'
  if (sentiment > 0.15) return '🟢'
  return '🟡'
}

function themeTrend(trend: TrendData | null, theme: Theme): { delta: number; priorCount: number } | null {
  if (!trend || trend.priorTotal === 0) return null
  const priorCount = trend.priorCounts.get(theme.name) ?? 0
  return { delta: theme.count - priorCount, priorCount }
}

function trendPhrase(t: { delta: number; priorCount: number } | null): string {
  if (!t) return ''
  if (t.delta > 0) return `, up from ${t.priorCount} last period`
  if (t.delta < 0) return `, down from ${t.priorCount} last period`
  return ', steady vs last period'
}

function mentionCount(count: number): string {
  return `${count} mention${count === 1 ? '' : 's'}`
}

function buildSlackReport(regionLabel: string, results: AnalysisResult, filteredThemes: Theme[], trend: TrendData | null): string {
  if (filteredThemes.length === 0) {
    return `*Timeleft Review Analysis — ${regionLabel}*\nNo themes match the current filters.`
  }

  const pct = reportPct(results)
  const [top, ...rest] = filteredThemes
  const topTrend = themeTrend(trend, top)

  const lines: string[] = []
  lines.push(`${priorityEmoji(top.sentiment)} *${top.name}* is the #1 ${themeNoun(top.sentiment)} across ${regionLabel} right now (${mentionCount(top.count)}${trendPhrase(topTrend)}, owner: ${top.team})`)
  lines.push(`Decide: ${top.action || 'review and assign an owner'}`)
  if (top.quotes[0]) {
    const q = top.quotes[0]
    lines.push(`💬 "${q.length > 140 ? q.slice(0, 140) + '…' : q}"`)
  }

  if (rest.length > 0) {
    lines.push('', 'Also flagged:')
    rest.forEach((t, i) => {
      const tTrend = themeTrend(trend, t)
      lines.push(`${i + 2}. ${priorityEmoji(t.sentiment)} *${t.name}* (${t.team}) — ${mentionCount(t.count)}${trendPhrase(tTrend)} → Decide: ${t.action || 'review'}`)
    })
  }

  lines.push(
    '',
    `_${results.totalReviews} reviews${results.dateRange ? ` · ${results.dateRange.earliest}–${results.dateRange.latest}` : ''} · ${pct(results.sentiment.negative)}% negative / ${pct(results.sentiment.positive)}% positive_`
  )
  return lines.join('\n')
}

function downloadReportPdf(regionLabel: string, results: AnalysisResult, filteredThemes: Theme[], trend: TrendData | null) {
  const pct = reportPct(results)
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margin = 16
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const maxWidth = pageWidth - margin * 2
  let y = margin

  // Default Helvetica only covers WinAnsi — normalize fancy punctuation / strip
  // unsupported glyphs so multilingual quotes don't render as blank boxes.
  const safe = (s: string) =>
    s
      .replace(/[\u2018\u2019\u201A]/g, "'")
      .replace(/[\u201C\u201D\u201E]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')

  const ensureSpace = (needed: number) => {
    if (y + needed <= pageHeight - margin) return
    doc.addPage()
    y = margin
  }

  const write = (text: string, opts?: { size?: number; style?: 'normal' | 'bold' | 'italic'; color?: [number, number, number]; gap?: number }) => {
    const size = opts?.size ?? 10
    const style = opts?.style ?? 'normal'
    const gap = opts?.gap ?? 1.2
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    if (opts?.color) doc.setTextColor(...opts.color)
    else doc.setTextColor(17, 17, 17)
    const lines = doc.splitTextToSize(safe(text), maxWidth) as string[]
    const lineHeight = size * 0.4
    ensureSpace(lines.length * lineHeight + gap)
    doc.text(lines, margin, y)
    y += lines.length * lineHeight + gap
  }

  write('Timeleft Review Analysis', { size: 16, style: 'bold', gap: 3 })
  write(regionLabel, { size: 11, color: [102, 102, 102], gap: 2 })
  if (results.dateRange) {
    write(`Data period: ${results.dateRange.earliest} – ${results.dateRange.latest}`, { size: 10, color: [102, 102, 102], gap: 4 })
  }

  write(`Reviews processed: ${results.totalReviews}`, { size: 11, style: 'bold', gap: 2 })
  if (trend) {
    if (trend.priorTotal > 0) {
      const delta = results.totalReviews - trend.priorTotal
      write(`vs prior period: ${delta >= 0 ? '+' : ''}${delta} (was ${trend.priorTotal})`, { size: 10, gap: 2 })
    } else {
      write('vs prior period: no comparable data', { size: 10, gap: 2 })
    }
  }
  write(
    `Sentiment: ${pct(results.sentiment.negative)}% negative, ${pct(results.sentiment.neutral)}% neutral, ${pct(results.sentiment.positive)}% positive`,
    { size: 10, gap: 4 }
  )
  write(`Themes (${filteredThemes.length} of ${results.themes.length}, ranked by impact)`, { size: 12, style: 'bold', gap: 4 })

  filteredThemes.forEach((t, i) => {
    ensureSpace(18)
    write(`${i + 1}. ${t.name}  ·  ${t.team}`, { size: 11, style: 'bold', gap: 1.5 })
    write(
      `${t.percentage}% of reviewers (${t.count} of ${results.totalReviews}) · impact ${Math.round(t.impact * 100)}/100`,
      { size: 10, color: [68, 68, 68], gap: 1.5 }
    )
    if (trend && trend.priorTotal > 0) {
      const priorCount = trend.priorCounts.get(t.name) ?? 0
      const delta = t.count - priorCount
      write(`vs prior: ${delta >= 0 ? '+' : ''}${delta}`, { size: 9, color: [68, 68, 68], gap: 1.5 })
    }
    if (t.count <= THEME_LOW_CONFIDENCE_MAX) {
      write(`Based on very few reviews (${t.count}) — treat as directional.`, { size: 9, color: [163, 91, 0], gap: 1.5 })
    }
    if (t.action) write(`Action: ${t.action}`, { size: 10, gap: 1.5 })
    if (t.quotes[0]) write(`"${t.quotes[0]}"`, { size: 9, style: 'italic', color: [51, 51, 51], gap: 3 })
    else y += 2
  })

  const stamp = new Date().toISOString().slice(0, 10)
  const safeLabel = regionLabel.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'report'
  doc.save(`timeleft-review-${safeLabel}-${stamp}.pdf`)
}

function buildTeamSlack(team: Team, themes: Theme[], total: number, trend: TrendData | null): string {
  if (themes.length === 0) return `*${team}* — no themes match the current filters.`

  const [top, ...rest] = themes
  const topTrend = themeTrend(trend, top)

  const lines = [
    `${priorityEmoji(top.sentiment)} *${top.name}* is ${team}'s #1 ${themeNoun(top.sentiment)} right now (${mentionCount(top.count)}${trendPhrase(topTrend)})`,
    `Decide: ${top.action || 'review and assign an owner'}`,
  ]
  if (top.quotes[0]) {
    const q = top.quotes[0]
    lines.push(`💬 "${q.length > 140 ? q.slice(0, 140) + '…' : q}"`)
  }

  if (rest.length > 0) {
    lines.push('', `Also up for ${team}:`)
    rest.forEach((t, i) => {
      const tTrend = themeTrend(trend, t)
      lines.push(`${i + 2}. ${priorityEmoji(t.sentiment)} *${t.name}* — ${mentionCount(t.count)}${trendPhrase(tTrend)} → Decide: ${t.action || 'review'}`)
    })
  }

  lines.push('', `_${total} reviews analysed_`, '→ Full dashboard: [link]')
  return lines.join('\n')
}
