'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { jsPDF } from 'jspdf'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { parseReviewsCsv, type Review } from './lib/parseReviews'
import {
  hashText, findCached, saveToCache, loadActive, saveActive, clearActive,
  loadResolved, saveResolved, loadResolverProfile, saveResolverProfile,
  type CachedAnalysis, type SavedFilters, type ResolvedMark
} from './lib/persistence'
import AnalystChat from './components/AnalystChat'

type Team = 'Product' | 'Tech' | 'CX & Support' | 'Ops' | 'Marketing' | 'Other'

const TEAMS: Team[] = ['Product', 'Tech', 'CX & Support', 'Ops', 'Marketing', 'Other']

interface Theme {
  name: string
  count: number
  percentage: number
  sentiment: number
  impact: number
  team: Team
  action: string
  quotes: QuoteSnippet[]
}

interface QuoteSnippet {
  text: string
  rating: number
  date: string
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

type SentimentKey = 'negative' | 'neutral' | 'positive'
type MonthKey = '2025-09' | '2025-10' | '2025-11'

const SENTIMENT_OPTIONS: Array<[SentimentKey, string]> = [
  ['negative', 'Negative'],
  ['neutral', 'Neutral'],
  ['positive', 'Positive'],
]

const SENTIMENT_KEYS = new Set<SentimentKey>(['negative', 'neutral', 'positive'])

function isSentimentKey(v: string): v is SentimentKey {
  return SENTIMENT_KEYS.has(v as SentimentKey)
}

/** Empty array = all sentiments. Migrates older single-value filter strings. */
function normalizeSentiments(raw: string | string[] | undefined | null): SentimentKey[] {
  if (Array.isArray(raw)) return raw.filter(isSentimentKey)
  if (!raw || raw === 'all') return []
  return isSentimentKey(raw) ? [raw] : []
}

/** Empty array = all teams. Migrates older single-value filter strings. */
function normalizeTeams(raw: string | string[] | undefined | null): Team[] {
  if (Array.isArray(raw)) return raw.filter((t): t is Team => (TEAMS as string[]).includes(t))
  if (!raw || raw === 'all') return []
  return (TEAMS as string[]).includes(raw) ? [raw as Team] : []
}

const MONTH_OPTIONS: Array<[MonthKey, string]> = [
  ['2025-09', 'Sep 25'],
  ['2025-10', 'Oct 25'],
  ['2025-11', 'Nov 25'],
]

const MONTH_LABEL: Record<MonthKey, string> = {
  '2025-09': 'Sep 25',
  '2025-10': 'Oct 25',
  '2025-11': 'Nov 25',
}

/** Prior calendar month for trend deltas (only when a single month is selected). */
const PRIOR_MONTH: Partial<Record<MonthKey, MonthKey>> = {
  '2025-10': '2025-09',
  '2025-11': '2025-10',
}

function isMonthKey(t: string): t is MonthKey {
  return t === '2025-09' || t === '2025-10' || t === '2025-11'
}

/** Empty array = all months. Migrates older single-value timeframe strings. */
function normalizeMonths(raw: string | string[] | undefined | null): MonthKey[] {
  if (Array.isArray(raw)) return raw.filter(isMonthKey)
  if (!raw || raw === 'all') return []
  return isMonthKey(raw) ? [raw] : []
}

function monthsLabel(selected: MonthKey[]): string {
  if (selected.length === 0 || selected.length === MONTH_OPTIONS.length) return 'All'
  if (selected.length === 1) return MONTH_LABEL[selected[0]]
  return selected.map(m => MONTH_LABEL[m]).join(', ')
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

function inTimeframe(dateStr: string, selectedMonths: MonthKey[]): boolean {
  if (selectedMonths.length === 0) return true
  const key = monthKey(dateStr)
  return !!key && selectedMonths.includes(key as MonthKey)
}

const REGION_NAMES = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
  ? new Intl.DisplayNames(['en-GB'], { type: 'region' })
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
function pickQuotes(reviews: Array<{ text: string; rating: number; date: string }>, max = 3): QuoteSnippet[] {
  const ranked = [...reviews]
    .filter(r => r.text.trim())
    .sort((a, b) => Math.abs(a.text.length - QUOTE_TARGET_LENGTH) - Math.abs(b.text.length - QUOTE_TARGET_LENGTH))
  return ranked.slice(0, max).map(r => ({
    text: r.text.length > 220 ? r.text.slice(0, 220).trimEnd() + '…' : r.text,
    rating: r.rating > 0 ? r.rating : 0,
    date: r.date,
  }))
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

function matchesCountries(reviewCountry: string, selected: string[]): boolean {
  return selected.length === 0 || selected.includes(reviewCountry)
}

function countriesLabel(selected: string[]): string {
  if (selected.length === 0) return 'All countries'
  if (selected.length === 1) return countryName(selected[0])
  if (selected.length <= 3) return selected.map(countryName).join(', ')
  return `${selected.length} countries`
}

// Re-slice the whole dashboard for the selected country/city, client-side.
// Themes keep the AI taxonomy but every number (count, %, sentiment, impact,
// quotes) is recomputed from the reviews that fall in the current region.
function computeView(reviews: Review[], taxonomy: ThemeTaxonomy[], selectedCountries: string[], city: string, selectedMonths: MonthKey[]): AnalysisResult {
  const inRegion = (r: Review) =>
    matchesCountries(r.country, selectedCountries) &&
    (city === 'all' || r.city === city) &&
    inTimeframe(r.date, selectedMonths)

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
      const quotes = pickQuotes(members.map(i => reviews[i]))
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

// Compares a single selected calendar month against the previous month in the
// export (Oct→Sep, Nov→Oct). All / multi-month selections have no prior window.
function computeTrend(reviews: Review[], taxonomy: ThemeTaxonomy[], selectedCountries: string[], city: string, selectedMonths: MonthKey[]): TrendData | null {
  if (selectedMonths.length !== 1) return null
  const prior = PRIOR_MONTH[selectedMonths[0]]
  if (!prior) return null

  const inRegion = (r: Review) => matchesCountries(r.country, selectedCountries) && (city === 'all' || r.city === city)

  const priorIdx = new Set<number>()
  reviews.forEach((r, i) => {
    if (!inRegion(r) || !inTimeframe(r.date, [prior])) return
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
  // region controls (empty countries / months = all)
  const [selectedCountries, setSelectedCountries] = useState<string[]>([])
  const [selectedMonths, setSelectedMonths] = useState<MonthKey[]>([])

  // dashboard controls (empty sentiment / team arrays = all)
  const [search, setSearch] = useState('')
  const [sentimentFilter, setSentimentFilter] = useState<SentimentKey[]>([])
  const [teamFilter, setTeamFilter] = useState<Team[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [activeSlackTeam, setActiveSlackTeam] = useState<Team | null>(null)
  const [copied, setCopied] = useState(false)

  // persistence: which cached analysis (by CSV hash) is currently open, and
  // whether there's a previous session on this browser worth offering to
  // resume. See app/lib/persistence.ts.
  const [activeHash, setActiveHash] = useState<string | null>(null)
  const [resumeCandidate, setResumeCandidate] = useState<{ entry: CachedAnalysis; filters: SavedFilters } | null>(null)
  const [resolvedThemes, setResolvedThemes] = useState<ResolvedMark[]>([])
  const [resolvedOpen, setResolvedOpen] = useState(true) // show stamped themes by default
  const [resolvePrompt, setResolvePrompt] = useState<string | null>(null)

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
    saveActive(activeHash, { countries: selectedCountries, city: 'all', timeframe: selectedMonths, sentimentFilter, teamFilter, search })
  }, [activeHash, selectedCountries, selectedMonths, sentimentFilter, teamFilter, search])

  useEffect(() => {
    if (!activeHash) return
    saveResolved(activeHash, resolvedThemes)
  }, [activeHash, resolvedThemes])

  const hydrateResolved = (csvHash: string) => {
    const marks = loadResolved(csvHash)
    setResolvedThemes(marks)
    setResolvedOpen(true)
  }

  const requestResolve = (themeName: string) => {
    if (resolvedThemes.some(m => m.themeName === themeName)) {
      setResolvedThemes(prev => prev.filter(m => m.themeName !== themeName))
      return
    }
    setResolvePrompt(themeName)
  }

  const confirmResolve = (themeName: string, byName: string, byTeam: string) => {
    const mark: ResolvedMark = {
      themeName,
      byName: byName.trim(),
      byTeam: byTeam.trim(),
      fixedAt: new Date().toISOString(),
    }
    saveResolverProfile({ name: mark.byName, team: mark.byTeam })
    setResolvedThemes(prev => [...prev.filter(m => m.themeName !== mark.themeName), mark])
    setResolvePrompt(null)
    setResolvedOpen(true)
  }

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

      // Same file already analysed on this browser — reuse the exact same
      // taxonomy instead of re-clustering. This is what makes repeat uploads
      // of the same export comparable rather than independently reworded.
      const cached = findCached(csvHash)
      if (cached) {
        setReviews(cached.reviews)
        setTaxonomy(cached.taxonomy as ThemeTaxonomy[])
        setSelectedCountries([])
        setSelectedMonths([])
        setSentimentFilter([])
        setTeamFilter([])
        setSearch('')
        setActiveHash(csvHash)
        hydrateResolved(csvHash)
        saveActive(csvHash, { countries: [], city: 'all', timeframe: [], sentimentFilter: [], teamFilter: [], search: '' })
        setParseInfo(`✓ Recognised this exact file from a previous analysis (${cached.reviews.length} reviews, analysed ${formatRelativeTime(cached.analyzedAt)}) — reused instantly, no re-analysis needed.`)
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
      setSelectedCountries([])
      setSelectedMonths([])
      setSentimentFilter([])
      setTeamFilter([])
      setSearch('')

      saveToCache({
        csvHash,
        filename: file.name,
        analyzedAt: new Date().toISOString(),
        reviews: parsedReviews,
        taxonomy: data.themes,
        hasCityData: !!detectedColumns.city
      })
      setActiveHash(csvHash)
      hydrateResolved(csvHash)
      saveActive(csvHash, { countries: [], city: 'all', timeframe: [], sentimentFilter: [], teamFilter: [], search: '' })
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
    setSelectedCountries(filters.countries)
    setSelectedMonths(normalizeMonths(filters.timeframe))
    setSentimentFilter(normalizeSentiments(filters.sentimentFilter))
    setTeamFilter(normalizeTeams(filters.teamFilter))
    setSearch(filters.search)
    setActiveHash(entry.csvHash)
    hydrateResolved(entry.csvHash)
    setParseInfo(`✓ Resumed previous analysis (${entry.reviews.length} reviews, analysed ${formatRelativeTime(entry.analyzedAt)}).`)
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
    setSentimentFilter([])
    setTeamFilter([])
    setExpanded(null)
    setActiveSlackTeam(null)
    setSelectedCountries([])
    setSelectedMonths([])
    setActiveHash(null)
    setResolvedThemes([])
    setResolvedOpen(false)
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
    () => (taxonomy ? computeView(reviews, taxonomy, selectedCountries, 'all', selectedMonths) : null),
    [taxonomy, reviews, selectedCountries, selectedMonths]
  )

  // Prior-period comparison for the same region, only meaningful once a
  // specific timeframe window is picked (see computeTrend).
  const trend = useMemo(
    () => (taxonomy ? computeTrend(reviews, taxonomy, selectedCountries, 'all', selectedMonths) : null),
    [taxonomy, reviews, selectedCountries, selectedMonths]
  )

  const filteredThemes = useMemo(() => {
    if (!view) return []
    const q = search.trim().toLowerCase()
    return view.themes.filter(t => {
      if (sentimentFilter.length > 0 && !sentimentFilter.includes(sentimentBucket(t.sentiment))) return false
      if (teamFilter.length > 0 && !teamFilter.includes(t.team)) return false
      if (q) {
        const hay = (t.name + ' ' + t.action + ' ' + t.team + ' ' + t.quotes.map(q => q.text).join(' ')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [view, search, sentimentFilter, teamFilter])

  const filteredReviews = useMemo(() => {
    return reviews.filter(r =>
      matchesCountries(r.country, selectedCountries) &&
      inTimeframe(r.date, selectedMonths)
    )
  }, [reviews, selectedCountries, selectedMonths])

  const chatFilterLabel = useMemo(() => {
    const parts = [
      countriesLabel(selectedCountries),
      monthsLabel(selectedMonths),
    ]
    if (sentimentFilter.length > 0) parts.push(`sentiment: ${sentimentFilter.join(', ')}`)
    if (teamFilter.length > 0) parts.push(`team: ${teamFilter.join(', ')}`)
    if (search.trim()) parts.push(`search: “${search.trim()}”`)
    return parts.join(' · ')
  }, [selectedCountries, selectedMonths, sentimentFilter, teamFilter, search])

  const onCountriesChange = (next: string[]) => { setSelectedCountries(next); setExpanded(null) }

  return (
    <main className="min-h-screen">
      {!view ? (
        <div className="min-h-screen flex flex-col items-center justify-center px-6 sm:px-8 py-16">
          <div className="text-center mb-10">
            <div className="brand-lockup justify-center">
              <span className="brand-name">Timeleft</span>
              <span className="brand-product">Review Analyser</span>
            </div>
            <p className="page-desc mt-3.5 mx-auto">
              Drop in your app-store review CSV. We group issues by theme, score how people feel, flag what needs fixing first, and point each one to the right team.
            </p>
          </div>
          {resumeCandidate && (
            <div className="panel w-full max-w-xl mb-5 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-semibold text-ink">Resume your last analysis?</p>
                <p className="text-sm text-muted-dark mt-0.5 leading-relaxed">
                  {resumeCandidate.entry.filename} · {resumeCandidate.entry.reviews.length} reviews · analysed {formatRelativeTime(resumeCandidate.entry.analyzedAt)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={dismissResume} className="btn-ghost">
                  Start fresh
                </button>
                <button type="button" onClick={resumeSession} className="btn-primary">
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
        <div className="max-w-6xl mx-auto px-6 sm:px-8 py-12 sm:py-14">
          <header className="mb-10">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="brand-lockup">
                  <span className="brand-name">Timeleft</span>
                  <span className="brand-product">Review Analyser</span>
                </div>
                <p className="page-desc mt-3">
                  Drop in your app-store review CSV. We group issues by theme, score how people feel, flag what needs fixing first, and point each one to the right team.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 shrink-0 sm:pt-1">
                <ExportReportButton
                  results={view}
                  filteredThemes={filteredThemes}
                  trend={trend}
                  regionLabel={`${countriesLabel(selectedCountries)} · ${monthsLabel(selectedMonths)}`}
                />
                <button type="button" onClick={resetAll} className="btn-primary">
                  ← New upload
                </button>
              </div>
            </div>
          </header>

          <RegionFilter
            countries={countries}
            selectedCountries={selectedCountries}
            onCountriesChange={onCountriesChange}
            selectedMonths={selectedMonths}
            onMonthsChange={m => { setSelectedMonths(m); setExpanded(null) }}
            totalAll={reviews.length}
            totalRegion={view.totalReviews}
          />

          <Dashboard
            results={view}
            filteredThemes={filteredThemes}
            filteredReviews={filteredReviews}
            chatFilterLabel={chatFilterLabel}
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
            resolvedThemes={resolvedThemes}
            onResolveToggle={requestResolve}
            resolvedOpen={resolvedOpen}
            setResolvedOpen={setResolvedOpen}
          />
        </div>
      )}

      {resolvePrompt && (
        <ResolvePromptModal
          themeName={resolvePrompt}
          onCancel={() => setResolvePrompt(null)}
          onConfirm={(name, team) => confirmResolve(resolvePrompt, name, team)}
        />
      )}
    </main>
  )
}

/* ---------- Upload ---------- */

const ANALYSIS_STEPS = [
  {
    title: 'Sorting the map',
    detail: 'We split the data by country and date.',
  },
  {
    title: 'Reading the room',
    detail: 'AI rates review sentiment from frustrated to delighted.',
  },
  {
    title: 'Ranking the fire',
    detail: 'We flag urgent matters so you know what to fix first.',
  },
  {
    title: 'Action plan',
    detail: 'Route each issue to the teams responsible.',
  },
] as const

function UploadCard(props: {
  file: File | null
  error: string
  parseInfo: string
  loading: boolean
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onAnalyze: () => void
}) {
  const { file, error, parseInfo, loading, onFileChange, onAnalyze } = props

  if (loading) {
    return (
      <div className="w-full max-w-xl">
        <AnalysisLoading />
      </div>
    )
  }

  return (
    <div className="w-full max-w-xl">
      <div className="panel p-8 sm:p-10">
        <div className="border border-dashed border-tan rounded-2xl px-6 py-12 text-center transition hover:border-accent hover:bg-cream/40">
          <input type="file" accept=".csv" onChange={onFileChange} className="hidden" id="csv-input" />
          <label htmlFor="csv-input" className="block cursor-pointer">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-cream border border-tan text-accent">
              <UploadIcon />
            </div>
            <p className="text-base font-semibold text-ink">
              {file ? file.name : 'Drop a CSV here, or click to browse'}
            </p>
            <p className="text-sm text-muted-dark mt-1.5">App Store or Google Play review export</p>
          </label>
        </div>

        {error && <p className="text-red-600 mt-5 text-center text-sm font-medium">{error}</p>}
        {parseInfo && !error && <p className="text-xs text-muted-dark mt-5 text-center">✓ {parseInfo}</p>}

        <button
          type="button"
          onClick={onAnalyze}
          disabled={!file}
          className="btn-primary w-full mt-7"
        >
          Analyse reviews
        </button>
      </div>
    </div>
  )
}

function AnalysisLoading() {
  const [step, setStep] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      setStep(s => Math.min(s + 1, ANALYSIS_STEPS.length - 1))
    }, 5000)
    return () => window.clearInterval(id)
  }, [])

  const progress = ((step + 1) / ANALYSIS_STEPS.length) * 100

  return (
    <div className="panel p-7 sm:p-8">
      <div className="brand-lockup mb-1">
        <span className="text-lg font-extrabold tracking-tight text-ink">Timeleft</span>
        <span className="text-lg font-medium text-muted-dark">Review Analyser</span>
      </div>
      <p className="text-sm text-muted-dark mb-6">Analysing your reviews…</p>

      <div className="h-1.5 rounded-full bg-tan overflow-hidden mb-7">
        <div
          className="h-full bg-accent transition-all duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      <ol className="space-y-5">
        {ANALYSIS_STEPS.map((item, i) => {
          const done = i < step
          const active = i === step
          return (
            <li key={item.title} className="flex gap-3.5 items-start">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  done
                    ? 'bg-ink text-cream'
                    : active
                      ? 'bg-accent text-white'
                      : 'bg-tan text-muted-dark'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${active || done ? 'text-ink' : 'text-muted-dark'}`}>
                  {item.title}
                  {active && (
                    <span className="inline-block ml-2 h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin align-[-2px]" />
                  )}
                </p>
                <p className={`text-sm mt-1 leading-relaxed ${active ? 'text-muted-dark' : 'text-muted'}`}>
                  {item.detail}
                </p>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function UploadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

/* ---------- Region filter ---------- */

function RegionFilter(props: {
  countries: Array<[string, number]>
  selectedCountries: string[]
  onCountriesChange: (codes: string[]) => void
  selectedMonths: MonthKey[]
  onMonthsChange: (months: MonthKey[]) => void
  totalAll: number
  totalRegion: number
}) {
  const { countries, selectedCountries, onCountriesChange, selectedMonths, onMonthsChange, totalAll, totalRegion } = props

  return (
    <div className="panel p-5 sm:p-6 mb-8">
      <div className="flex flex-col lg:flex-row lg:items-end gap-5">
        <div className="flex-1 min-w-0">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-2">Country</label>
          <CountryMultiSelect
            countries={countries}
            selected={selectedCountries}
            onChange={onCountriesChange}
            totalAll={totalAll}
          />
        </div>

        <div className="w-full lg:w-52 shrink-0">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-2">Timeframe</label>
          <TimeframeMultiSelect selected={selectedMonths} onChange={onMonthsChange} />
        </div>

        <div className="lg:pb-2 lg:pl-2 lg:text-right shrink-0 lg:min-w-[8.5rem]">
          <p className="text-xs text-muted-dark">Showing</p>
          <p className="text-lg font-extrabold text-ink leading-tight mt-0.5">
            {totalRegion.toLocaleString()}<span className="text-sm font-medium text-muted-dark"> / {totalAll.toLocaleString()}</span>
          </p>
          <p className="text-[11px] text-muted-dark mt-0.5 leading-snug">
            {countriesLabel(selectedCountries)} · {monthsLabel(selectedMonths)}
          </p>
        </div>
      </div>
    </div>
  )
}

function TimeframeMultiSelect({
  selected,
  onChange,
}: {
  selected: MonthKey[]
  onChange: (months: MonthKey[]) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const allSelected = selected.length === 0 || selected.length === MONTH_OPTIONS.length

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const toggleMonth = (month: MonthKey) => {
    if (selected.includes(month)) {
      const next = selected.filter(m => m !== month)
      onChange(next.length === MONTH_OPTIONS.length ? [] : next)
    } else {
      const next = [...selected, month]
      onChange(next.length === MONTH_OPTIONS.length ? [] : next)
    }
  }

  const selectAll = () => onChange([])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full h-9 rounded-pill border border-tan bg-cream px-4 text-sm font-semibold text-ink focus:outline-none focus:border-accent cursor-pointer text-left flex items-center justify-between gap-2"
      >
        <span className="truncate">{monthsLabel(selected)}</span>
        <span className="text-muted-dark shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-30 rounded-2xl border border-tan bg-white py-1.5 shadow-lg">
          <button
            type="button"
            onClick={selectAll}
            className="w-full text-left px-4 py-2.5 text-sm font-semibold text-ink hover:bg-cream transition flex items-center gap-2.5"
          >
            <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${allSelected ? 'bg-ink border-ink text-cream' : 'border-tan bg-white'}`}>
              {allSelected ? '✓' : ''}
            </span>
            All
          </button>
          <div className="my-1 border-t border-tan" />
          {MONTH_OPTIONS.map(([key, label]) => {
            const checked = !allSelected && selected.includes(key)
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleMonth(key)}
                className="w-full text-left px-4 py-2.5 text-sm font-semibold text-ink hover:bg-cream transition flex items-center gap-2.5"
              >
                <span className={`inline-flex h-4 w-4 items-center justify-center rounded border text-[11px] ${checked ? 'bg-ink border-ink text-cream' : 'border-tan bg-white'}`}>
                  {checked ? '✓' : ''}
                </span>
                {label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CountryMultiSelect({
  countries,
  selected,
  onChange,
  totalAll,
}: {
  countries: Array<[string, number]>
  selected: string[]
  onChange: (codes: string[]) => void
  totalAll: number
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const q = query.trim().toLowerCase()

  const suggestions = useMemo(() => {
    return countries
      .filter(([code]) => !selectedSet.has(code))
      .filter(([code]) => {
        if (!q) return true
        const name = countryName(code).toLowerCase()
        return name.includes(q) || code.toLowerCase().includes(q)
      })
      .slice(0, 8)
  }, [countries, selectedSet, q])

  const add = (code: string) => {
    if (selectedSet.has(code)) return
    onChange([...selected, code])
    setQuery('')
    setOpen(true)
    inputRef.current?.focus()
  }

  const remove = (code: string) => {
    onChange(selected.filter(c => c !== code))
  }

  return (
    <div ref={rootRef} className="relative">
      <div
        className="relative w-full min-h-9 rounded-pill border border-tan bg-cream px-3 py-1.5 flex flex-wrap items-center gap-1.5 focus-within:border-accent cursor-text"
        onClick={() => { setOpen(true); inputRef.current?.focus() }}
      >
        {selected.length === 0 && !query && (
          <span className="text-sm text-muted pointer-events-none absolute left-4">
            All countries ({totalAll}) — type to filter
          </span>
        )}
        {selected.map(code => (
          <span
            key={code}
            className="inline-flex items-center gap-1 rounded-pill bg-white border border-tan pl-2.5 pr-1 py-0.5 text-xs font-semibold text-ink"
          >
            {countryName(code)}
            <button
              type="button"
              aria-label={`Remove ${countryName(code)}`}
              onClick={e => { e.stopPropagation(); remove(code) }}
              className="h-5 w-5 rounded-full hover:bg-tan text-muted-dark hover:text-ink transition leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Backspace' && !query && selected.length > 0) {
              remove(selected[selected.length - 1])
            }
            if (e.key === 'Enter' && suggestions[0]) {
              e.preventDefault()
              add(suggestions[0][0])
            }
            if (e.key === 'Escape') setOpen(false)
          }}
          className="flex-1 min-w-[7rem] bg-transparent text-sm font-semibold text-ink placeholder:text-muted focus:outline-none py-1"
          placeholder={selected.length > 0 ? 'Add another…' : ''}
          aria-label="Search countries"
          autoComplete="off"
        />
      </div>

      {open && (suggestions.length > 0 || q.length > 0) && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-30 max-h-56 overflow-y-auto rounded-2xl border border-tan bg-white py-1.5 shadow-lg">
          {suggestions.length === 0 ? (
            <p className="px-4 py-2.5 text-sm text-muted-dark">No countries match “{query.trim()}”</p>
          ) : (
            suggestions.map(([code, count]) => (
              <button
                key={code}
                type="button"
                onClick={() => add(code)}
                className="w-full text-left px-4 py-2.5 text-sm font-semibold text-ink hover:bg-cream transition flex items-center justify-between gap-3"
              >
                <span>{countryName(code)}</span>
                <span className="text-xs font-medium text-muted-dark">{count}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- Dashboard ---------- */

function Dashboard(props: {
  results: AnalysisResult
  filteredThemes: Theme[]
  filteredReviews: Review[]
  chatFilterLabel: string
  trend: TrendData | null
  search: string
  setSearch: (s: string) => void
  sentimentFilter: SentimentKey[]
  setSentimentFilter: (s: SentimentKey[]) => void
  teamFilter: Team[]
  setTeamFilter: (t: Team[]) => void
  expanded: number | null
  setExpanded: (n: number | null) => void
  activeSlackTeam: Team | null
  setActiveSlackTeam: (t: Team | null) => void
  copied: boolean
  setCopied: (b: boolean) => void
  resolvedThemes: ResolvedMark[]
  onResolveToggle: (themeName: string) => void
  resolvedOpen: boolean
  setResolvedOpen: (o: boolean) => void
}) {
  const {
    results, filteredThemes, filteredReviews, chatFilterLabel, trend, search, setSearch, sentimentFilter, setSentimentFilter,
    teamFilter, setTeamFilter, expanded, setExpanded, activeSlackTeam, setActiveSlackTeam, copied, setCopied,
    resolvedThemes, onResolveToggle, resolvedOpen, setResolvedOpen,
  } = props

  const resolvedByName = useMemo(() => {
    const map = new Map<string, ResolvedMark>()
    resolvedThemes.forEach(m => map.set(m.themeName, m))
    return map
  }, [resolvedThemes])
  const openThemes = filteredThemes.filter(t => !resolvedByName.has(t.name))
  const doneThemes = filteredThemes.filter(t => resolvedByName.has(t.name))
  // When showing resolved, keep original rank order so the stamp appears in place.
  const visibleThemes = resolvedOpen ? filteredThemes : openThemes

  const total = results.totalReviews
  const topUrgent = results.themes.find(t => !resolvedByName.has(t.name)) || null
  const rated = results.sentiment.negative + results.sentiment.neutral + results.sentiment.positive
  const volumeDelta = trend && trend.priorTotal > 0 ? total - trend.priorTotal : null

  const renderTheme = (theme: Theme) => {
    const resolved = resolvedByName.has(theme.name)
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
        resolved={resolved}
        resolvedMark={resolvedByName.get(theme.name) || null}
        onToggleResolved={() => onResolveToggle(theme.name)}
      />
    )
  }

  return (
    <div className="space-y-8">
      {total > 0 && total < REGION_SMALL_SAMPLE_MAX && (
        <div className="rounded-2xl border border-amber-300/80 bg-amber-50/90 px-5 py-3.5 text-sm text-amber-900 leading-relaxed">
          <span className="font-semibold">⚠ Small sample ({total} reviews in this view).</span> Percentages and rankings can swing a lot with each new review — treat as directional, not definitive.
        </div>
      )}

      {/* A. Flash metric row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <MetricCard label="Reviews processed">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-extrabold tracking-tight text-ink">{total.toLocaleString()}</span>
            <span className="text-sm text-muted-dark">reviews</span>
          </div>
          <p className="text-xs text-muted-dark mt-3 leading-relaxed">{results.themes.length} themes identified</p>
          {results.dateRange && (
            <p className="text-[11px] text-muted mt-1.5">{results.dateRange.earliest} – {results.dateRange.latest}</p>
          )}
          {trend && (
            <p className="text-[11px] font-semibold mt-1.5 leading-relaxed">
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

        <SentimentMetricCard breakdown={results.sentiment} rated={rated} />

        <MetricCard label="Most urgent issue">
          {topUrgent ? (
            <div>
              <p className="font-semibold text-ink leading-snug">{topUrgent.name}</p>
              <p className="text-sm text-muted-dark mt-1.5 leading-relaxed">
                <span className="text-accent font-bold">{topUrgent.percentage}%</span> of reviews · {topUrgent.count}/{total}
              </p>
              <div className="mt-3 h-1.5 rounded-full bg-tan overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${Math.round(topUrgent.impact * 100)}%` }} />
              </div>
              <p className="text-[11px] text-muted-dark mt-1.5" title={IMPACT_FORMULA_TOOLTIP}>
                urgency {Math.round(topUrgent.impact * 100)}/100 ⓘ · owner: {topUrgent.team}
              </p>
              {topUrgent.count <= THEME_LOW_CONFIDENCE_MAX && (
                <p className="text-[11px] text-amber-700 font-semibold mt-1.5 leading-relaxed">⚠ Based on very few reviews ({topUrgent.count}) — treat as directional, not definitive.</p>
              )}
            </div>
          ) : <p className="text-muted-dark">—</p>}
        </MetricCard>
      </div>

      {/* B. Controls + theme dashboard */}
      <div className="panel p-6 sm:p-8">
        <ThemesSectionHeader />

        {/* search + filters */}
        <div className="flex flex-col gap-4 mt-5 mb-6">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search themes, quotes, actions…"
            className="w-full h-9 rounded-pill border border-tan bg-cream px-5 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-2">Sentiment</label>
              <ChipMultiSelect
                selected={sentimentFilter}
                onChange={setSentimentFilter}
                options={SENTIMENT_OPTIONS}
                emptyLabel="All sentiments"
                addLabel="Add sentiment…"
                ariaLabel="Filter by sentiment"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-2">Team</label>
              <ChipMultiSelect
                selected={teamFilter}
                onChange={setTeamFilter}
                options={TEAMS.map(t => [t, t] as [Team, string])}
                emptyLabel="All teams"
                addLabel="Add team…"
                ariaLabel="Filter by team"
              />
            </div>
          </div>
        </div>

        {filteredThemes.length === 0 ? (
          <p className="text-sm text-muted-dark py-8 text-center">No themes match these filters.</p>
        ) : (
          <div className="space-y-3.5">
            {visibleThemes.length === 0 ? (
              <p className="text-sm text-muted-dark py-5 text-center border border-dashed border-tan rounded-2xl">
                All matching themes are marked as solved. Show resolved below to see their stamps.
              </p>
            ) : (
              visibleThemes.map(theme => renderTheme(theme))
            )}

            {doneThemes.length > 0 && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setResolvedOpen(!resolvedOpen)}
                  className="w-full flex items-center justify-between rounded-2xl border border-tan bg-cream/70 px-4 h-10 text-sm font-semibold text-muted-dark hover:text-ink transition"
                >
                  <span>
                    {resolvedOpen ? 'Hide resolved' : 'Show resolved'} ({doneThemes.length})
                  </span>
                  <span className="text-xs">{resolvedOpen ? '▲' : '▼'}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="panel p-6 sm:p-7">
          <h3 className="font-bold text-ink mb-5">Rating distribution</h3>
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
        <div className="panel p-6 sm:p-7">
          <h3 className="font-bold text-ink mb-5">Review volume over time</h3>
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
        themes={results.themes.filter(t => !resolvedByName.has(t.name))}
        total={total}
        trend={trend}
        activeSlackTeam={activeSlackTeam}
        setActiveSlackTeam={setActiveSlackTeam}
        copied={copied}
        setCopied={setCopied}
      />

      {/* D. AI analyst chat — answers against the current filtered slice */}
      <AnalystChat
        context={{
          filterLabel: chatFilterLabel,
          totalReviews: results.totalReviews,
          sentiment: results.sentiment,
          dateRange: results.dateRange,
          themes: filteredThemes.map(t => ({
            name: t.name,
            count: t.count,
            percentage: t.percentage,
            impact: t.impact,
            team: t.team,
            action: t.action,
            sentiment: t.sentiment,
            quotes: t.quotes.map(q => q.text),
          })),
          reviews: filteredReviews.slice(0, 80).map(r => ({
            rating: r.rating,
            date: r.date,
            country: r.country,
            text: r.text,
          })),
        }}
      />
    </div>
  )
}

function ThemesSectionHeader() {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex items-center gap-2 mb-1">
      <h2 className="text-xl font-bold tracking-tight text-ink">Themes, ranked by impact</h2>
      <InfoLightbulb onClick={() => setOpen(true)} />
      {open && (
        <HowCalculatedDialog onClose={() => setOpen(false)} titleId="themes-how-calculated">
          <section>
            <h4 className="font-semibold text-ink mb-1">1. Themes</h4>
            <p>
              AI reads every review in your CSV and groups them into a handful of concrete themes
              (for example “subscription pricing” or “app crashes”). A single review can belong to
              more than one theme, so percentages don’t have to add up to 100%. Each theme also gets
              an owner team and a suggested next step.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-ink mb-1">2. Sentiment</h4>
            <p>
              Sentiment comes from star ratings in the export — not from guessing the tone of the text.
              1–2★ count as frustrated, 3★ as mixed, and 4–5★ as delighted. For each theme we average
              the ratings of the reviews inside it, so you can see whether that topic is dragging mood down.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-ink mb-1">3. Impact (urgency score)</h4>
            <p className="mb-2">
              Impact is a 0–100 score that decides the ranking. It’s built from three signals:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><span className="font-semibold text-ink">60% volume</span> — how many reviewers mention this theme</li>
              <li><span className="font-semibold text-ink">25% negativity</span> — how low the average rating is for those reviews</li>
              <li><span className="font-semibold text-ink">15% urgency language</span> — a bonus if reviews use words like cancel, refund, crash, charge, or uninstall</li>
            </ul>
          </section>

          <section>
            <h4 className="font-semibold text-ink mb-1">4. What you should do with it</h4>
            <p>
              Themes at the top of the list are the ones hitting the most people with the worst mood —
              start there. Click any theme to read the exact quotes behind it, then use “Select the team
              responsible” to hand the work to the right owners.
            </p>
          </section>
        </HowCalculatedDialog>
      )}
    </div>
  )
}

function SentimentMetricCard({ breakdown, rated }: { breakdown: AnalysisResult['sentiment']; rated: number }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="panel p-6">
      <div className="flex items-center gap-1.5 mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-dark">Sentiment (from star ratings)</p>
        <InfoLightbulb onClick={() => setOpen(true)} className="h-6 w-6" />
      </div>

      <button
        type="button"
        onClick={() => setOpen(true)}
        title="How it's calculated"
        aria-label="How sentiment is calculated"
        className="w-full text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <SentimentBar breakdown={breakdown} rated={rated} />
      </button>

      {open && (
        <HowCalculatedDialog onClose={() => setOpen(false)} titleId="sentiment-how-calculated">
          <section>
            <h4 className="font-semibold text-ink mb-1">Where the bar comes from</h4>
            <p>
              This bar is built only from star ratings in your CSV — we don’t infer mood from the written
              text here. Every review with a rating is sorted into one bucket, then shown as a share of
              all rated reviews.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-ink mb-1">The three buckets</h4>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><span className="font-semibold text-ink">Frustrated (😞)</span> — 1★ and 2★ reviews</li>
              <li><span className="font-semibold text-ink">Mixed (😐)</span> — 3★ reviews</li>
              <li><span className="font-semibold text-ink">Delighted (😊)</span> — 4★ and 5★ reviews</li>
            </ul>
            <p className="mt-2">
              Reviews with no rating are left out of the percentages, so the three segments always add up to 100%
              of rated reviews.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-ink mb-1">How this differs from theme sentiment</h4>
            <p>
              The bar above is the whole slice you’re viewing (country + timeframe). Theme-level sentiment
              is different: for each theme we average the star ratings of only the reviews tagged to that theme,
              which is why one theme can look worse than the overall bar.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-ink mb-1">How to read it quickly</h4>
            <p>
              A fat red/frustrated segment means lots of low scores in this view — dig into the top themes
              ranked by impact to see what’s driving it. A mostly green/delighted bar means scores are healthy,
              even if some themes still need attention.
            </p>
          </section>
        </HowCalculatedDialog>
      )}
    </div>
  )
}

function InfoLightbulb({ onClick, className = 'h-8 w-8' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="How it's calculated"
      aria-label="How it's calculated"
      className={`inline-flex items-center justify-center rounded-full text-muted-dark hover:text-accent hover:bg-cream transition ${className}`}
    >
      <LightbulbIcon />
    </button>
  )
}

function HowCalculatedDialog({
  onClose,
  titleId,
  children,
}: {
  onClose: () => void
  titleId: string
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="panel shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-7 sm:p-8"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <h3 id={titleId} className="text-lg font-bold text-ink">How it&apos;s calculated</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-dark hover:text-ink text-xl leading-none px-1"
          >
            ×
          </button>
        </div>

        <div className="space-y-5 text-sm text-muted-dark leading-relaxed">
          {children}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="btn-primary w-full mt-7"
        >
          Got it
        </button>
      </div>
    </div>
  )
}

function LightbulbIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z" />
    </svg>
  )
}

function MetricCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="panel p-6">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-dark mb-3.5">{label}</p>
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
      <div className="flex justify-between mt-2.5 text-xs gap-2">
        <span style={{ color: SENTIMENT_COLORS.negative }} className="font-semibold whitespace-nowrap">😞 {pct(breakdown.negative)}%</span>
        <span className="text-muted-dark font-semibold whitespace-nowrap">😐 {pct(breakdown.neutral)}%</span>
        <span style={{ color: SENTIMENT_COLORS.positive }} className="font-semibold whitespace-nowrap">😊 {pct(breakdown.positive)}%</span>
      </div>
    </div>
  )
}

function ChipMultiSelect<T extends string>({
  selected,
  onChange,
  options,
  emptyLabel,
  addLabel,
  ariaLabel,
}: {
  selected: T[]
  onChange: (next: T[]) => void
  options: Array<[T, string]>
  emptyLabel: string
  addLabel: string
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const labelByValue = useMemo(() => new Map(options), [options])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const remaining = options.filter(([value]) => !selectedSet.has(value))
  const allSelected = selected.length === 0 || selected.length === options.length

  const add = (value: T) => {
    const next = [...selected, value]
    onChange(next.length === options.length ? [] : next)
    setOpen(true)
  }

  const remove = (value: T) => {
    onChange(selected.filter(v => v !== value))
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="relative w-full min-h-9 rounded-pill border border-tan bg-cream px-3 py-1.5 flex flex-wrap items-center gap-1.5 text-left focus:outline-none focus:border-accent"
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        {allSelected ? (
          <span className="text-sm text-muted-dark px-1">{emptyLabel}</span>
        ) : (
          selected.map(value => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded-pill bg-white border border-tan pl-2.5 pr-1 py-0.5 text-xs font-semibold text-ink"
            >
              {labelByValue.get(value) || value}
              <span
                role="button"
                tabIndex={0}
                aria-label={`Remove ${labelByValue.get(value) || value}`}
                onClick={e => { e.stopPropagation(); remove(value) }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    remove(value)
                  }
                }}
                className="h-5 w-5 rounded-full hover:bg-tan text-muted-dark hover:text-ink transition leading-none inline-flex items-center justify-center cursor-pointer"
              >
                ×
              </span>
            </span>
          ))
        )}
        {!allSelected && remaining.length > 0 && (
          <span className="text-xs text-muted px-1">{addLabel}</span>
        )}
        <span className="ml-auto text-muted-dark shrink-0 text-xs px-1">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-30 rounded-2xl border border-tan bg-white py-1.5 shadow-lg">
          <button
            type="button"
            onClick={() => { onChange([]); setOpen(false) }}
            className="w-full text-left px-4 py-2.5 text-sm font-semibold text-ink hover:bg-cream transition flex items-center gap-2.5"
          >
            <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${allSelected ? 'bg-ink border-ink text-cream' : 'border-tan bg-white'}`}>
              {allSelected ? '✓' : ''}
            </span>
            All
          </button>
          <div className="my-1 border-t border-tan" />
          {options.map(([value, label]) => {
            const checked = !allSelected && selectedSet.has(value)
            return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  if (checked) remove(value)
                  else add(value)
                }}
                className="w-full text-left px-4 py-2.5 text-sm font-semibold text-ink hover:bg-cream transition flex items-center gap-2.5"
              >
                <span className={`inline-flex h-4 w-4 items-center justify-center rounded border text-[11px] ${checked ? 'bg-ink border-ink text-cream' : 'border-tan bg-white'}`}>
                  {checked ? '✓' : ''}
                </span>
                {label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatFixedDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `${dd}/${mm}/${yy}`
}

function ThemeRow({ theme, rank, total, isOpen, onToggle, trendDelta, resolved, resolvedMark, onToggleResolved }: {
  theme: Theme
  rank: number
  total: number
  isOpen: boolean
  onToggle: () => void
  trendDelta: number | null
  resolved: boolean
  resolvedMark: ResolvedMark | null
  onToggleResolved: () => void
}) {
  return (
    <div className={`rounded-2xl border overflow-hidden transition ${resolved ? 'border-info/30 bg-cream/60' : 'border-tan bg-white'}`}>
      <div className="flex items-stretch gap-1">
        <button
          type="button"
          onClick={onToggle}
          className={`min-w-0 flex-1 text-left px-5 py-4 transition flex gap-4 items-start ${resolved ? '' : 'hover:bg-cream/60'}`}
        >
          <span className="text-lg font-extrabold text-muted w-6 shrink-0 pt-0.5">{rank}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`font-semibold ${resolved ? 'text-muted-dark line-through' : 'text-ink'}`}>{theme.name}</span>
              <TeamBadge team={theme.team} />
              <span className="text-sm">{sentimentEmoji(theme.sentiment)}</span>
              {!resolved && theme.count <= THEME_LOW_CONFIDENCE_MAX && (
                <span className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-pill px-2 h-6 inline-flex items-center font-semibold whitespace-nowrap">
                  ⚠ low sample (n={theme.count})
                </span>
              )}
            </div>
            {resolved && resolvedMark && (
              <p className="mt-2 inline-flex items-center gap-1.5 max-w-full text-xs font-semibold text-info bg-white border border-info/30 rounded-pill pl-2.5 pr-3 py-1 leading-snug">
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-info text-white text-[10px]" aria-hidden>✓</span>
                <span className="min-w-0">
                  by {resolvedMark.byName} in {resolvedMark.byTeam}, {formatFixedDate(resolvedMark.fixedAt)}
                </span>
              </p>
            )}
            <p className="text-sm text-muted-dark mt-1.5 leading-relaxed">
              <span className={`font-semibold ${resolved ? 'text-muted-dark' : 'text-ink'}`}>{theme.percentage}% of reviewers mention this</span> ({theme.count} of {total}) — {theme.action || 'flagged this theme'}
            </p>
            <div className="mt-2.5 h-1.5 rounded-full bg-tan overflow-hidden max-w-xs">
              <div className={`h-full ${resolved ? 'bg-muted' : 'bg-accent'}`} style={{ width: `${Math.round(theme.impact * 100)}%` }} />
            </div>
          </div>
          <div className="text-right shrink-0 pt-0.5" title={IMPACT_FORMULA_TOOLTIP}>
            <p className={`text-2xl font-extrabold tracking-tight ${resolved ? 'text-muted' : 'text-accent'}`}>{Math.round(theme.impact * 100)}</p>
            <p className="text-[11px] text-muted-dark">impact ⓘ</p>
            {trendDelta !== null && (
              <p className={`text-[11px] font-semibold mt-1 ${trendDelta > 0 ? 'text-accent' : trendDelta < 0 ? 'text-info' : 'text-muted-dark'}`}>
                {trendDelta > 0 ? '▲' : trendDelta < 0 ? '▼' : '–'} {trendDelta === 0 ? 'no change' : `${trendDelta > 0 ? '+' : ''}${trendDelta} vs prior`}
              </p>
            )}
            <p className="text-[11px] text-accent mt-1.5 whitespace-nowrap">{isOpen ? 'Hide quotes ▲' : 'Show quotes ▼'}</p>
          </div>
        </button>

        <div className="shrink-0 flex items-start pr-4 pt-4">
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleResolved() }}
            className={`rounded-pill h-8 px-3.5 text-xs font-semibold border transition whitespace-nowrap ${
              resolved
                ? 'bg-white text-muted-dark border-tan hover:border-ink hover:text-ink'
                : 'bg-cream text-ink border-tan hover:border-accent'
            }`}
            title={resolved ? 'Move back to open issues' : 'Mark as solved so teammates skip it'}
          >
            {resolved ? 'Reopen' : 'Mark as solved'}
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="px-5 pb-5 pt-3 bg-cream/80 border-t border-tan">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-dark mb-3">Top quotes backing this theme</p>
          {theme.quotes.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {theme.quotes.slice(0, 3).map((q, i) => (
                <AppStoreReviewCard key={i} quote={q} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-dark">No quotes returned for this theme.</p>
          )}
        </div>
      )}
    </div>
  )
}

function AppStoreReviewCard({ quote }: { quote: QuoteSnippet }) {
  const stars = Math.max(0, Math.min(5, Math.round(quote.rating)))
  const parsed = quote.date ? Date.parse(quote.date) : NaN
  const dateLabel = !isNaN(parsed) ? formatDate(parsed) : null

  return (
    <article className="bg-white rounded-2xl border border-tan/80 shadow-[0_1px_2px_rgba(17,17,17,0.04)] p-4 flex flex-col gap-2.5 min-h-[9.5rem]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-0.5" aria-label={stars > 0 ? `${stars} out of 5 stars` : 'No rating'}>
          {[1, 2, 3, 4, 5].map(n => (
            <StarIcon key={n} filled={n <= stars} />
          ))}
        </div>
        {dateLabel && (
          <time className="text-[11px] text-muted whitespace-nowrap">{dateLabel}</time>
        )}
      </div>
      <p className="text-sm text-ink leading-relaxed flex-1">
        {quote.text}
      </p>
    </article>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
      className={filled ? 'text-accent' : 'text-tan'}
      fill="currentColor"
    >
      <path d="M12 2.5l2.9 5.88 6.5.95-4.7 4.58 1.11 6.47L12 17.77l-5.81 3.06 1.11-6.47-4.7-4.58 6.5-.95L12 2.5z" />
    </svg>
  )
}

function ResolvePromptModal({
  themeName,
  onCancel,
  onConfirm,
}: {
  themeName: string
  onCancel: () => void
  onConfirm: (name: string, team: string) => void
}) {
  const [name, setName] = useState('')
  const [team, setTeam] = useState<string>('Product')
  const [error, setError] = useState('')

  useEffect(() => {
    const profile = loadResolverProfile()
    if (profile) {
      setName(profile.name)
      setTeam(profile.team)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Please enter your name')
      return
    }
    if (!team.trim()) {
      setError('Please choose your team')
      return
    }
    onConfirm(name.trim(), team.trim())
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4"
      onClick={onCancel}
      role="presentation"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="resolve-prompt-title"
        onSubmit={submit}
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-3xl border border-tan shadow-xl max-w-md w-full p-7 sm:p-8"
      >
        <h3 id="resolve-prompt-title" className="text-lg font-bold tracking-tight text-ink mb-1.5">Mark as solved</h3>
        <p className="text-sm text-muted-dark mb-6 leading-relaxed">
          Stamp <span className="font-semibold text-ink">“{themeName}”</span> with who fixed it, so the next person knows it&apos;s handled.
        </p>

        <label htmlFor="resolver-name" className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-2">Your name</label>
        <input
          id="resolver-name"
          autoFocus
          value={name}
          onChange={e => { setName(e.target.value); if (error) setError('') }}
          placeholder="e.g. Alex"
          className="w-full h-9 rounded-pill border border-tan bg-cream px-5 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent mb-4"
        />

        <label htmlFor="resolver-team" className="block text-xs font-semibold uppercase tracking-wide text-muted-dark mb-2">Your team</label>
        <select
          id="resolver-team"
          value={team}
          onChange={e => setTeam(e.target.value)}
          className="w-full h-9 rounded-pill border border-tan bg-cream px-5 text-sm font-semibold text-ink focus:outline-none focus:border-accent cursor-pointer mb-2"
        >
          {TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        {error && <p className="text-sm font-medium text-red-600 mt-2" role="alert">{error}</p>}

        <div className="flex gap-2.5 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="btn-secondary flex-1"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary flex-1"
          >
            Confirm
          </button>
        </div>
      </form>
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

  const selected = byTeam.find(g => g.team === activeSlackTeam) || null
  const [showSlack, setShowSlack] = useState(false)

  const selectTeam = (team: Team) => {
    setActiveSlackTeam(team)
    setShowSlack(false)
    setCopied(false)
  }

  return (
    <div className="panel p-6 sm:p-8">
      <h2 className="text-xl font-bold tracking-tight text-ink mb-1.5">Select the team responsible</h2>
      <p className="text-sm text-muted-dark mb-6 max-w-md leading-relaxed">
        Pick your team to see only the actions that belong to you.
      </p>

      <div className="flex flex-wrap gap-2 mb-7">
        {byTeam.map(({ team, items }) => {
          const isActive = activeSlackTeam === team
          return (
            <button
              key={team}
              type="button"
              onClick={() => selectTeam(team)}
              className={`rounded-pill h-9 px-4 text-sm font-semibold transition border inline-flex items-center gap-2 whitespace-nowrap ${
                isActive
                  ? 'bg-ink text-cream border-ink'
                  : 'bg-white text-ink border-tan hover:border-accent'
              }`}
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TEAM_DOT[team] }} />
              {team}
              <span className={`text-xs ${isActive ? 'text-cream/70' : 'text-muted-dark'}`}>{items.length}</span>
            </button>
          )
        })}
      </div>

      {!selected ? (
        <p className="text-sm text-muted-dark py-6 text-center border border-dashed border-tan rounded-2xl">
          Choose a team above to see its action items.
        </p>
      ) : (
        <div className="rounded-2xl border border-tan bg-cream/30 p-5 sm:p-6">
          <div className="flex items-center justify-between mb-5">
            <TeamBadge team={selected.team} />
            <span className="text-xs text-muted-dark">
              {selected.items.length} {selected.items.length === 1 ? 'theme' : 'themes'}
            </span>
          </div>

          <ul className="space-y-3.5 mb-6">
            {selected.items.map(t => (
              <li key={t.name} className="text-sm leading-relaxed">
                <span className="font-semibold text-ink">{t.name}</span>
                <span className="text-muted-dark"> — {t.percentage}% · </span>
                <span className="text-ink">{t.action || 'review flagged theme'}</span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => { setShowSlack(s => !s); setCopied(false) }}
            className="btn-accent"
          >
            {showSlack ? 'Hide Slack draft' : `Draft Slack for ${selected.team}`}
          </button>

          {showSlack && (
            <div className="mt-4">
              <div className="bg-ink rounded-2xl p-4 font-mono text-xs text-cream whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
                {buildTeamSlack(selected.team, selected.items, total, trend)}
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(buildTeamSlack(selected.team, selected.items, total, trend))
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
                className="btn-primary mt-3 h-8 px-4 text-xs"
              >
                {copied ? 'Copied ✓' : 'Copy to clipboard'}
              </button>
            </div>
          )}
        </div>
      )}
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
        type="button"
        onClick={() => setOpen(o => !o)}
        className="btn-secondary"
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
    if (t.quotes[0]) lines.push(`   Quote: "${t.quotes[0].text}"`)
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
    'Sent from Timeleft Review Analyser',
  ].join('\n')
}

// --- Decision-first framing for the Slack outputs (per-team and whole-view) ---
// Slack messages here lead with a declarative headline ("X is the #1 issue
// at the moment, up from Y") plus an explicit "Decide:" line, rather than opening
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
  lines.push(`${priorityEmoji(top.sentiment)} *${top.name}* is the #1 ${themeNoun(top.sentiment)} across ${regionLabel} at the moment (${mentionCount(top.count)}${trendPhrase(topTrend)}, owner: ${top.team})`)
  lines.push(`Decide: ${top.action || 'review and assign an owner'}`)
  if (top.quotes[0]) {
    const q = top.quotes[0].text
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
    if (t.quotes[0]) write(`"${t.quotes[0].text}"`, { size: 9, style: 'italic', color: [51, 51, 51], gap: 3 })
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
    `${priorityEmoji(top.sentiment)} *${top.name}* is ${team}'s #1 ${themeNoun(top.sentiment)} at the moment (${mentionCount(top.count)}${trendPhrase(topTrend)})`,
    `Decide: ${top.action || 'review and assign an owner'}`,
  ]
  if (top.quotes[0]) {
    const q = top.quotes[0].text
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
