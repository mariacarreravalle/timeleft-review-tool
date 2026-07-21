'use client'

import { useState } from 'react'
import Papa from 'papaparse'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

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
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })

      const reviews: Review[] = parsed.data
        .map((row: any) => ({
          date: row['Submission date'] || row['Date'] || '',
          rating: parseInt(row['Rating']) || 0,
          text: row['Translated review'] || row['Review'] || ''
        }))
        .filter(r => r.text.trim().length > 0)

      if (reviews.length === 0) {
        setError('No valid reviews found in CSV')
        setLoading(false)
        return
      }

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviews })
      })

      if (!response.ok) throw new Error('Analysis failed')
      const data = await response.json()
      setResults(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Timeleft Review Analyzer</h1>
          <p className="text-slate-600">Upload CSV of app reviews → Get themes, sentiment, severity, and trends</p>
        </div>

        {!results ? (
          <div className="bg-white rounded-lg shadow-lg p-8 max-w-2xl">
            <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-slate-400 transition">
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="hidden"
                id="csv-input"
              />
              <label htmlFor="csv-input" className="cursor-pointer block">
                <div className="text-5xl mb-4">📊</div>
                <p className="text-lg font-medium text-slate-900 mb-2">
                  {file ? `Selected: ${file.name}` : 'Drag & drop CSV or click to select'}
                </p>
                <p className="text-sm text-slate-500">
                  Columns: Review/Translated review, Rating, Submission date
                </p>
              </label>
            </div>

            {error && <p className="text-red-600 mt-4 text-center">{error}</p>}

            <button
              onClick={handleAnalyze}
              disabled={!file || loading}
              className="w-full mt-6 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-semibold py-3 px-6 rounded-lg transition"
            >
              {loading ? 'Analyzing...' : 'Analyze Reviews'}
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <button
              onClick={() => {
                setResults(null)
                setFile(null)
              }}
              className="text-blue-600 hover:text-blue-700 font-medium text-sm"
            >
              ← Upload another CSV
            </button>

            {/* Severity-ranked themes */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-2xl font-bold text-slate-900 mb-4">🔥 Top Issues by Severity</h2>
              <div className="space-y-3">
                {results.themes.slice(0, 5).map((theme, i) => (
                  <div key={i} className="border-l-4 border-red-500 pl-4 py-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-semibold text-slate-900">{theme.name}</p>
                        <p className="text-sm text-slate-600 mt-1">
                          {theme.volume} reviews • Sentiment: {theme.sentiment > 0 ? '😊' : theme.sentiment < 0 ? '😞' : '😐'} ({theme.sentiment.toFixed(2)})
                        </p>
                        {theme.quotes.length > 0 && (
                          <p className="text-sm italic text-slate-500 mt-2">
                            "{theme.quotes[0].slice(0, 80)}..."
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-red-600">{(theme.severity * 100).toFixed(0)}</p>
                        <p className="text-xs text-slate-500">severity</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Ratings distribution */}
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="font-bold text-slate-900 mb-4">Rating Distribution</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={results.overallRatings}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="rating" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="count" fill="#3b82f6" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Volume over time */}
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="font-bold text-slate-900 mb-4">Review Volume Over Time</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={results.volumeOverTime}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Slack draft */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-bold text-slate-900 mb-3">📱 Draft Slack Update</h2>
              <div className="bg-slate-50 border border-slate-200 rounded p-4 font-mono text-sm text-slate-700 whitespace-pre-wrap max-h-48 overflow-y-auto">
                {results.slackDraft}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(results.slackDraft)}
                className="mt-3 bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded text-sm transition"
              >
                Copy to clipboard
              </button>
              <p className="text-xs text-slate-500 mt-2">
                Ready to paste into MAKE/Zapier workflow or manually send to Slack
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
