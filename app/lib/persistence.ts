import type { Review } from './parseReviews'

// A small client-only convenience cache — not a database. It survives page
// refreshes and repeat uploads of the same file within one browser; it does
// not sync across devices, browsers, or teammates. Two concerns share one
// storage shape for simplicity:
//   1. "Resume where I left off" after a refresh (needs the full reviews
//      array, since there's no file to re-read).
//   2. "I re-uploaded a file I already analysed" — skip the AI call and
//      reuse the same taxonomy, so the same file always yields the same
//      themes instead of a fresh (and possibly different) re-clustering.

export interface CachedAnalysis {
  csvHash: string
  filename: string
  analyzedAt: string // ISO timestamp
  reviews: Review[]
  taxonomy: Array<{ name: string; team: string; action: string; reviewIndexes: number[] }>
  hasCityData: boolean
}

export interface SavedFilters {
  countries: string[]
  city: string
  timeframe: string | string[]
  /** Empty / missing / `'all'` = all. Also accepts a legacy single value. */
  sentimentFilter: string | string[]
  /** Empty / missing / `'all'` = all. Also accepts a legacy single value. */
  teamFilter: string | string[]
  search: string
}

const CACHE_KEY = 'timeleft-analyzer:cache:v1'
const ACTIVE_KEY = 'timeleft-analyzer:active:v1'
const MAX_CACHE_ENTRIES = 5

// Fast, non-cryptographic hash — this is a cache key, not a security
// boundary, so collision-resistance requirements are minimal.
export function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export function loadCache(): CachedAnalysis[] {
  if (typeof window === 'undefined') return []
  return safeParse<CachedAnalysis[]>(localStorage.getItem(CACHE_KEY)) || []
}

export function findCached(hash: string): CachedAnalysis | null {
  return loadCache().find(c => c.csvHash === hash) || null
}

export function saveToCache(entry: CachedAnalysis): void {
  if (typeof window === 'undefined') return
  try {
    const existing = loadCache().filter(c => c.csvHash !== entry.csvHash)
    const next = [entry, ...existing].slice(0, MAX_CACHE_ENTRIES)
    localStorage.setItem(CACHE_KEY, JSON.stringify(next))
  } catch {
    // Quota exceeded or storage disabled — caching is a convenience, not a
    // requirement for the app to work, so fail silently rather than crash.
  }
}

export function loadActive(): { csvHash: string; filters: SavedFilters } | null {
  if (typeof window === 'undefined') return null
  const raw = safeParse<{ csvHash: string; filters: SavedFilters & { country?: string } }>(localStorage.getItem(ACTIVE_KEY))
  if (!raw) return null
  // Migrate older single-country filter shape.
  const f = raw.filters
  const countries = Array.isArray(f.countries)
    ? f.countries
    : (f.country && f.country !== 'all' ? [f.country] : [])
  return {
    csvHash: raw.csvHash,
    filters: {
      countries,
      city: f.city || 'all',
      timeframe: f.timeframe,
      sentimentFilter: f.sentimentFilter,
      teamFilter: f.teamFilter,
      search: f.search || '',
    },
  }
}

export function saveActive(csvHash: string, filters: SavedFilters): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ csvHash, filters }))
  } catch {
    // ignore — same reasoning as saveToCache
  }
}

export function clearActive(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(ACTIVE_KEY)
}

// Resolved theme stamps, keyed by CSV hash so the same export keeps its
// "already fixed" marks across refreshes (this browser only).
const RESOLVED_KEY = 'timeleft-analyzer:resolved:v2'
const RESOLVER_PROFILE_KEY = 'timeleft-analyzer:resolver-profile:v1'

export interface ResolvedMark {
  themeName: string
  byName: string
  byTeam: string
  fixedAt: string // ISO date
}

export interface ResolverProfile {
  name: string
  team: string
}

function normalizeResolvedList(raw: unknown): ResolvedMark[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item): ResolvedMark | null => {
      if (typeof item === 'string') {
        // Migrate v1 entries that were bare theme names.
        return { themeName: item, byName: 'Unknown', byTeam: 'Other', fixedAt: new Date().toISOString() }
      }
      if (!item || typeof item !== 'object') return null
      const o = item as Record<string, unknown>
      const themeName = String(o.themeName || '').trim()
      if (!themeName) return null
      return {
        themeName,
        byName: String(o.byName || 'Unknown').trim() || 'Unknown',
        byTeam: String(o.byTeam || 'Other').trim() || 'Other',
        fixedAt: String(o.fixedAt || new Date().toISOString()),
      }
    })
    .filter((x): x is ResolvedMark => !!x)
}

export function loadResolved(csvHash: string): ResolvedMark[] {
  if (typeof window === 'undefined' || !csvHash) return []
  const all = safeParse<Record<string, unknown>>(localStorage.getItem(RESOLVED_KEY)) || {}
  // Also try v1 key once for migration.
  if (!(csvHash in all)) {
    const v1 = safeParse<Record<string, unknown>>(localStorage.getItem('timeleft-analyzer:resolved:v1')) || {}
    if (csvHash in v1) return normalizeResolvedList(v1[csvHash])
  }
  return normalizeResolvedList(all[csvHash])
}

export function saveResolved(csvHash: string, marks: ResolvedMark[]): void {
  if (typeof window === 'undefined' || !csvHash) return
  try {
    const all = safeParse<Record<string, ResolvedMark[]>>(localStorage.getItem(RESOLVED_KEY)) || {}
    all[csvHash] = marks
    localStorage.setItem(RESOLVED_KEY, JSON.stringify(all))
  } catch {
    // ignore — same reasoning as saveToCache
  }
}

export function loadResolverProfile(): ResolverProfile | null {
  if (typeof window === 'undefined') return null
  const raw = safeParse<ResolverProfile>(localStorage.getItem(RESOLVER_PROFILE_KEY))
  if (!raw?.name?.trim()) return null
  return { name: raw.name.trim(), team: (raw.team || '').trim() || 'Other' }
}

export function saveResolverProfile(profile: ResolverProfile): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(RESOLVER_PROFILE_KEY, JSON.stringify({
      name: profile.name.trim(),
      team: profile.team.trim(),
    }))
  } catch {
    // ignore
  }
}
