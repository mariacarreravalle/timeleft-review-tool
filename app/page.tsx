'use client'

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold mb-2">Timeleft Review Analyzer</h1>
        <p className="text-gray-600 mb-8">Upload CSV of app store reviews to get insights</p>
        <div className="bg-white rounded-lg shadow p-6">
          <p>Loading...</p>
        </div>
      </div>
    </main>
  )
}
