# Timeleft Review Analyzer

A web tool for non-technical teams (Ops, Product) to upload CSV of app store reviews and get instant insights: top themes by volume, sentiment per theme, severity scoring, trends vs prior window, and rating/volume charts.

## Features

- **CSV Upload**: Drag-and-drop or click to upload app store review CSVs
- **Theme Extraction**: LLM-powered clustering of reviews into actionable themes
- **Sentiment Analysis**: Per-theme sentiment scoring
- **Severity Scoring**: Automatic ranking of issues by impact (volume + sentiment + urgency signals)
- **Trend Analysis**: Compare current reviews against a prior window to spot momentum
- **Charts**: Visual breakdown of ratings and review volume over time
- **Slack Integration**: Draft a Slack update from top findings (ready to push via MAKE/Zapier)

## Quick Start

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000)

Upload a CSV with columns:
- `Submission date` - ISO datetime
- `Review` or `Translated review` - review text
- `Rating` - 1-5 numerical rating
- `Store`, `Country`, `Version` - optional metadata for filtering

## What We Built

### File Structure

```
app/
  page.tsx          - Main upload + results UI
  layout.tsx        - Root layout with Tailwind
  api/
    analyze/        - POST endpoint for review analysis
globals.css         - Tailwind imports
```

### Key Decisions & Tradeoffs

**Why Next.js 14 + Turbo:**
- Fast cold starts for Vercel deployment
- Streaming API responses (future: real-time analysis progress)
- Built-in CSV parsing on client to avoid large uploads
- Tailwind for quick, non-technical-friendly UI

**Why Claude API for theme extraction:**
- Handles multi-language reviews (German, Portuguese, etc.) without extra config
- Clusters themes by semantic meaning, not keyword matching
- Extracts representative quotes automatically
- Sentiment scoring is contextual (e.g., "it's expensive but worth it" reads differently than "it's expensive and useless")

**What I skipped and why:**
1. **User authentication** – Not in spec. Single-upload flow; no persistence needed.
2. **Database** – No requirement to save analyses across sessions. All in-memory during processing.
3. **Real-time websockets** – Unnecessary. CSV parsing is <1s on client, API call is <5s.
4. **Custom theme taxonomy** – Teams don't want to configure categories. LLM auto-clustering is faster to ship and works across domains.
5. **Filtering/sorting UI** – Scope creep. Focus on the first output; teams can ask for it later.
6. **SEO/analytics** – Internal tool for case study, not production web product.

**Why no polling/retry logic:**
- Small CSV (600 rows) means single API call, no partial progress.
- If it fails, user re-uploads. Simple.

## Deployment

1. Push to GitHub:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/timeleft-review-tool.git
   git branch -M main
   git push -u origin main
   ```

2. Deploy to Vercel:
   - Go to https://vercel.com
   - Click "Import Project"
   - Paste your GitHub repo URL
   - Click "Deploy"
   - Vercel auto-builds on every push to `main`

3. Environment variables:
   - Add `ANTHROPIC_API_KEY` to Vercel project settings
   - (Vercel will prompt for it if you try to deploy without it)

4. Your deployed URL will be: `https://timeleft-review-tool.vercel.app`

## Next Steps (In Priority Order)

### High-value, low-effort:
1. **Comparison date range picker** – Let users pick "compare against last 2 weeks" instead of hardcoded. ~30 min.
2. **Export results as CSV** – Analysts want to pivot the data in Excel. ~20 min.
3. **Theme/sentiment drill-down** – Click a theme to see all reviews that match it. ~40 min.

### Nice-to-have but deferred:
- Downloadable Slack message template (render as rich JSON for MAKE to consume)
- Multi-CSV upload (batch compare app versions)
- Caching layer (store parsed CSVs to avoid re-processing identical uploads)

### Technical debt (skip for now):
- Rate limiting on API
- Error tracking (Sentry)
- Input validation (max file size, column validation)
- Proper logging
- Unit tests

## Decisions Made Thinking

**Theme extraction via prompt:** Initially considered training a simple classifier on labeled examples, but decided against it because:
- 600 reviews is a tiny dataset
- Themes vary wildly across domains (app pricing, UX bugs, feature requests)
- LLM clustering is "good enough" and ships now
- If accuracy becomes a blocker, we have a clear path to fine-tune

**Sentiment as a score, not binary:** Reviews like "great app but expensive" need nuance. We ask Claude for a -1 to +1 scale per theme, not just "positive/negative." Costs more tokens, but gives Product teams the signal they actually need.

**Severity = volume + sentiment + urgency:** Not just "most reviews talk about X." We weight it by:
- How many reviews mention the theme (volume)
- Average sentiment of those reviews (are they positive complaints or negative rants?)
- Presence of keywords like "refund," "cancel," "uninstall," "waste" (urgency)

This way, "users want more cities" (high volume, neutral) ranks differently from "can't cancel subscription" (moderate volume, high urgency).

---

## Chat History

Full conversation available in GitHub commit messages and this README's decisions section. The user emphasized:
- "Push back, flag dead ends, don't sanitize" → We skipped over-engineering (auth, persistence, ML training).
- "Build for the consumer" (non-technical teams) → Simple upload, no config, one-click Slack draft.
- "2-3 hours, shouldn't take more" → Constrained scope strictly. No UI polish, no animations, focus on insights quality.
