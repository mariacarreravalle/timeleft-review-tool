export interface Review {
  date: string
  rating: number
  text: string
  country: string  // raw value from the CSV (e.g. ISO code "us"), '' if absent
  city: string     // raw value from the CSV, '' if no city column
}

export interface ParseResult {
  reviews: Review[]
  detectedColumns: {
    reviewText: string | null
    translatedText: string | null
    rating: string | null
    date: string | null
    country: string | null
    city: string | null
  }
  totalRows: number
  emptyTextRows: number
}

const ID_LINE_REGEX = /^"?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{6,})\s*,/

function stripTrailingSemicolon(line: string): string {
  const t = line.trimEnd()
  return t.endsWith(';') ? t.slice(0, -1) : t
}

/** Count the number of `"` characters in a line — used for quote-parity continuation. */
function countQuotes(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i++) if (line[i] === '"') n++
  return n
}

/**
 * Reconstruct true logical CSV rows from physical lines. Two formats are handled:
 *
 * 1. App-store review exports (most lines start with a UUID or long numeric id):
 *    rows whose text contains a comma get the ENTIRE row wrapped in an extra outer
 *    quote (inner quotes doubled), and multi-paragraph reviews are split across
 *    physical lines with blank ";" filler lines instead of proper CSV quoting. The
 *    leading id is the only reliable "new record" signal, so we merge everything
 *    between one id-line and the next.
 *
 * 2. Any other CSV: standard handling — one row per physical line, joining lines
 *    only while a quoted field is left open (odd number of quotes so far).
 *
 * We pick the mode by checking whether the file actually uses app-store ids, so a
 * generic CSV with short/custom ids (or no id column) isn't force-merged.
 */
function normalizeRawCsv(raw: string): string[] {
  const rawLines = raw.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (rawLines.length === 0) return []

  const dataLines = rawLines.slice(1)
  const idMatches = dataLines.filter(l => ID_LINE_REGEX.test(l)).length
  const usesIdFormat = dataLines.length > 0 && idMatches / dataLines.length >= 0.3

  if (usesIdFormat) {
    const merged: string[] = []
    for (const rawLine of rawLines) {
      const stripped = stripTrailingSemicolon(rawLine)
      if (ID_LINE_REGEX.test(rawLine) || merged.length === 0) {
        merged.push(stripped)
      } else {
        const content = stripped.trim()
        if (content.length > 0) merged[merged.length - 1] += ' ' + content
      }
    }
    return merged.map(unwrapOuterQuotes)
  }

  // Generic CSV: join lines only while inside an open quoted field.
  const merged: string[] = []
  let current = ''
  let openQuotes = 0
  for (const rawLine of rawLines) {
    current = current ? current + '\n' + rawLine : rawLine
    openQuotes += countQuotes(rawLine)
    if (openQuotes % 2 === 0) {
      merged.push(current)
      current = ''
      openQuotes = 0
    }
  }
  if (current) merged.push(current)
  return merged
}

/** Strip an extra outer quote layer (and un-double inner quotes) if present. */
function unwrapOuterQuotes(row: string): string {
  if (row.startsWith('"') && row.endsWith('"')) {
    return row.slice(1, -1).replace(/""/g, '"')
  }
  return row
}

/**
 * Splits one logical CSV row into fields. A '"' only acts as a real field
 * delimiter when it's immediately adjacent to a comma or the row boundary —
 * a stray quote used as emphasis mid-sentence in human-written review text
 * (common in this kind of data) is treated as a literal character instead of
 * breaking the parse.
 */
function splitCsvRow(row: string): string[] {
  const fields: string[] = []
  let i = 0
  const n = row.length

  while (i <= n) {
    if (row[i] === '"') {
      i++
      let field = ''
      while (i < n) {
        if (row[i] === '"') {
          if (row[i + 1] === '"') {
            field += '"'
            i += 2
          } else if (row[i + 1] === ',' || i + 1 === n) {
            i++
            break
          } else {
            field += '"'
            i++
          }
        } else {
          field += row[i]
          i++
        }
      }
      fields.push(field)
      i++
    } else {
      let field = ''
      while (i < n && row[i] !== ',') {
        field += row[i]
        i++
      }
      fields.push(field)
      i++
    }
    if (i > n) break
  }
  return fields
}

function findColumn(headers: string[], keywords: string[], exclude: string[] = []): string | null {
  const candidates = headers.filter(h => !exclude.includes(h))
  const lower = candidates.map(h => h.toLowerCase().trim())

  for (const kw of keywords) {
    const idx = lower.findIndex(h => h === kw)
    if (idx !== -1) return candidates[idx]
  }
  for (const kw of keywords) {
    const idx = lower.findIndex(h => h.includes(kw) && !h.includes('id'))
    if (idx !== -1) return candidates[idx]
  }
  return null
}

export function parseReviewsCsv(raw: string): ParseResult {
  const rows = normalizeRawCsv(raw)
  if (rows.length === 0) {
    return {
      reviews: [],
      detectedColumns: { reviewText: null, translatedText: null, rating: null, date: null, country: null, city: null },
      totalRows: 0,
      emptyTextRows: 0
    }
  }

  const headers = splitCsvRow(rows[0])
  const dataRows = rows.slice(1).map(splitCsvRow)

  const translatedCol = findColumn(headers, ['translated'])
  const originalCol = findColumn(
    headers,
    ['review', 'comment', 'feedback', 'text', 'content', 'body'],
    translatedCol ? [translatedCol] : []
  )
  const ratingCol = findColumn(headers, ['rating', 'score', 'stars'])
  const dateCol = findColumn(headers, ['submission date', 'date', 'submitted', 'created', 'timestamp'])
  // "country" not "language" — exclude the review-language column so we don't
  // mistake a locale for a market.
  const languageCol = findColumn(headers, ['language', 'locale'])
  const countryCol = findColumn(headers, ['country', 'market', 'region'], languageCol ? [languageCol] : [])
  const cityCol = findColumn(headers, ['city', 'town', 'metro', 'location'])

  const translatedIdx = translatedCol ? headers.indexOf(translatedCol) : -1
  const originalIdx = originalCol ? headers.indexOf(originalCol) : -1
  const ratingIdx = ratingCol ? headers.indexOf(ratingCol) : -1
  const dateIdx = dateCol ? headers.indexOf(dateCol) : -1
  const countryIdx = countryCol ? headers.indexOf(countryCol) : -1
  const cityIdx = cityCol ? headers.indexOf(cityCol) : -1

  let emptyTextRows = 0
  const reviews: Review[] = []

  for (const fields of dataRows) {
    const translated = translatedIdx >= 0 ? (fields[translatedIdx] || '').trim() : ''
    const original = originalIdx >= 0 ? (fields[originalIdx] || '').trim() : ''
    const text = translated || original

    if (!text) {
      emptyTextRows++
      continue
    }

    reviews.push({
      date: dateIdx >= 0 ? (fields[dateIdx] || '') : '',
      rating: ratingIdx >= 0 ? (parseInt(fields[ratingIdx], 10) || 0) : 0,
      text,
      country: countryIdx >= 0 ? (fields[countryIdx] || '').trim() : '',
      city: cityIdx >= 0 ? (fields[cityIdx] || '').trim() : ''
    })
  }

  return {
    reviews,
    detectedColumns: { reviewText: originalCol, translatedText: translatedCol, rating: ratingCol, date: dateCol, country: countryCol, city: cityCol },
    totalRows: dataRows.length,
    emptyTextRows
  }
}
