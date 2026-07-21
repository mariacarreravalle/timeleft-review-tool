export interface Review {
  date: string
  rating: number
  text: string
}

export interface ParseResult {
  reviews: Review[]
  detectedColumns: {
    reviewText: string | null
    translatedText: string | null
    rating: string | null
    date: string | null
  }
  totalRows: number
  emptyTextRows: number
}

const ID_LINE_REGEX = /^"?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{6,})\s*,/

function stripTrailingSemicolon(line: string): string {
  const t = line.trimEnd()
  return t.endsWith(';') ? t.slice(0, -1) : t
}

/**
 * Some app-store review exports produce malformed CSV: rows whose text fields
 * contain a comma get the ENTIRE row wrapped in an extra outer quote (doubling
 * every inner quote), while simple rows stay plain. Multi-paragraph reviews are
 * also split across several physical lines using blank ";" filler lines instead
 * of proper CSV multi-line quoting. This reconstructs true logical rows before
 * any field-level parsing happens, using each review's leading ID (UUID or a
 * long numeric app-store id) as the signal for "this line starts a new record".
 */
function normalizeRawCsv(raw: string): string[] {
  const rawLines = raw.split(/\r?\n/)
  const mergedLines: string[] = []

  for (const rawLine of rawLines) {
    if (rawLine.trim().length === 0) continue
    const stripped = stripTrailingSemicolon(rawLine)
    if (ID_LINE_REGEX.test(rawLine) || mergedLines.length === 0) {
      mergedLines.push(stripped)
    } else {
      const content = stripped.trim()
      if (content.length > 0) {
        mergedLines[mergedLines.length - 1] += ' ' + content
      }
    }
  }

  return mergedLines.map(row => {
    if (row.startsWith('"') && row.endsWith('"')) {
      return row.slice(1, -1).replace(/""/g, '"')
    }
    return row
  })
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
      detectedColumns: { reviewText: null, translatedText: null, rating: null, date: null },
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

  const translatedIdx = translatedCol ? headers.indexOf(translatedCol) : -1
  const originalIdx = originalCol ? headers.indexOf(originalCol) : -1
  const ratingIdx = ratingCol ? headers.indexOf(ratingCol) : -1
  const dateIdx = dateCol ? headers.indexOf(dateCol) : -1

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
      text
    })
  }

  return {
    reviews,
    detectedColumns: { reviewText: originalCol, translatedText: translatedCol, rating: ratingCol, date: dateCol },
    totalRows: dataRows.length,
    emptyTextRows
  }
}
