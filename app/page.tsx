'use client'

import { useState } from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { parseReviewsCsv } from './lib/parseReviews'

interface Theme {
  name: string
  volume: number
  sentiment: number
  severity: number
  quotes: string[]
  trend: number
}

interface AnalysisResult {
  themes: Theme[]
  overallRatings: Array<{ rating: number; count: number }>
  volumeOverTime: Array<{ date: string; count: number }>
  slackDraft: string
}

export default function Home() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<AnalysisResult | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [copied, setCopied] = useState(false)
  const [parseInfo, setParseInfo] = useState('')

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

      if (reviews.length === 0) {
        setError('No review text found. Make sure the CSV has a column like "Review", "Comment", or "Feedback".')
        setLoading(false)
        return
      }

      if (!detectedColumns.reviewText && !detectedColumns.translatedText) {
        setError('Could not find a review text column in this CSV.')
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
        // Surface the real server error instead of a generic message
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || `Analysis failed (HTTP ${response.status})`)
      }
      const data = await response.json()
      setResults(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = () => {
    if (!results) return
    navigator.clipboard.writeText(results.slackDraft)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <main className="min-h-screen bg-cream">
      <div className="max-w-5xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-extrabold tracking-tight text-ink">Timeleft</span>
              <span className="text-2xl font-medium text-muted-dark">Review Analyzer</span>
            </div>
            <p className="text-muted-dark mt-1">
              Upload app store reviews. Get themes, sentiment, severity, and trends — no spreadsheets required.
            </p>
          </div>
          {results && (
            <button
              onClick={() => {
                setResults(null)
                setFile(null)
              }}
              className="rounded-pill bg-ink text-cream font-semibold text-sm px-5 py-2.5 hover:bg-black transition"
            >
              ← New upload
            </button>
          )}
        </div>

        {!results ? (
          <div className="bg-white rounded-3xl border border-tan p-10 max-w-2xl">
            <div className="border-2 border-dashed border-tan rounded-2xl p-10 text-center hover:border-accent transition">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="hidden"
                id="csv-input"
              />
              <label htmlFor="csv-input" className="cursor-pointer block">
                <div className="text-5xl mb-4">📊</div>
                <p className="text-lg font-semibold text-ink mb-2">
                  {file ? file.name : 'Drag & drop CSV, or click to select'}
                </p>
                <p className="text-sm text-muted-dark">
                  Needs: Review / Translated review, Rating, Submission date
                </p>
              </label>
            </div>

            {error && <p className="text-red-600 mt-4 text-center font-medium">{error}</p>}
            {parseInfo && !error && !loading && (
              <p className="text-xs text-muted-dark mt-4 text-center">✓ {parseInfo}</p>
            )}

            {loading ? (
              <div className="mt-6 rounded-2xl border border-tan bg-cream p-6 text-center">
                <div className="flex items-center justify-center gap-3 mb-2">
                  <span className="inline-block h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                  <span className="font-semibold text-ink">Analysing your reviews…</span>
                </div>
                <p className="text-sm text-muted-dark">
                  Clustering themes, scoring sentiment &amp; severity. This usually takes 10–20 seconds.
                </p>
                {parseInfo && <p className="text-xs text-muted-dark mt-3">✓ {parseInfo}</p>}
              </div>
            ) : (
              <button
                onClick={handleAnalyze}
                disabled={!file}
                className="w-full mt-6 rounded-pill bg-ink hover:bg-black disabled:bg-muted disabled:cursor-not-allowed text-cream font-semibold py-3.5 px-6 transition"
              >
                Analyze reviews
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Severity-ranked themes */}
            <div className="bg-white rounded-3xl border border-tan p-7">
              <h2 className="text-xl font-bold text-ink mb-1">Top issues, ranked by severity</h2>
              <p className="text-sm text-muted-dark mb-5">Volume × sentiment × urgency signals (cancel, refund, crash, etc.)</p>
              <div className="space-y-4">
                {results.themes.slice(0, 5).map((theme, i) => (
                  <div key={i} className="flex justify-between items-start gap-4 rounded-2xl border border-tan p-5">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{theme.name}</p>
                      <p className="text-sm text-muted-dark mt-1">
                        {theme.volume} {theme.volume === 1 ? 'review' : 'reviews'} · sentiment {theme.sentiment > 0 ? '+' : ''}{theme.sentiment.toFixed(2)}
                      </p>
                      {theme.quotes.length > 0 && (
                        <p className="text-sm italic text-muted-dark mt-2 truncate">
                          "{theme.quotes[0].slice(0, 90)}…"
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-3xl font-extrabold text-accent">{(theme.severity * 100).toFixed(0)}</p>
                      <p className="text-xs text-muted-dark">severity</p>
                    </div>
                  </div>
                ))}
              </div>
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

            {/* Slack draft */}
            <div className="bg-white rounded-3xl border border-tan p-7">
              <h2 className="text-xl font-bold text-ink mb-3">Draft Slack update</h2>
              <div className="bg-ink rounded-2xl p-5 font-mono text-sm text-cream whitespace-pre-wrap max-h-48 overflow-y-auto">
                {results.slackDraft}
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={handleCopy}
                  className="rounded-pill bg-accent hover:bg-orange-600 text-white font-semibold py-2.5 px-5 text-sm transition"
                >
                  {copied ? 'Copied ✓' : 'Copy to clipboard'}
                </button>
                <p className="text-xs text-muted-dark">
                  Paste into your MAKE/Zapier workflow, or send to Slack directly
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
