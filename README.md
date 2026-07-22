# Timeleft Review Analyser

Internal tool for turning app-store review CSVs into ranked themes, urgency scores, and team actions.

Upload a CSV → AI clusters the issues → filter the view → mark what’s fixed → export or ask follow-ups in plain English.

---

## Live access

| | |
|---|---|
| **URL** | https://timeleft-review-tool.vercel.app/ |
| **Password** | [Provided via email for security] |

Open the URL, unlock with the password, and upload a review CSV. No local setup required for day-to-day use.

---

## What it does

- **Theme clustering** — Groups reviews into concrete issues, each with an owner team and suggested next step
- **Urgency ranking** — Scores impact from volume, negativity, and urgent language
- **Filters** — Multi-select country, timeframe, sentiment, and team
- **Evidence** — App Store–style quote cards under each theme
- **Mark as solved** — Stamps an issue with name, team, and date (`dd/mm/yy`)
- **Ask the analyst** — Plain-English questions over the current filtered slice
- **Export** — PDF download, or copy as Slack / email text
- **Access gate** — Password unlock with a server-side session; API routes are protected

---

## How to use

1. Open the live URL and unlock with the shared password  
2. Upload an App Store or Google Play review CSV  
3. Wait for analysis (progress replaces the upload card)  
4. Filter by country, month, sentiment, or team as needed  
5. Expand a theme to read quote cards; mark issues solved when fixed  
6. Use **Ask the analyst** for follow-up questions  
7. Export a PDF or copy Slack / email text for stakeholders  

Repeat uploads of the same file reuse the cached taxonomy in that browser, so you don’t re-spend on identical exports.

---

## Local setup

For development only.

```bash
npm install
cp .env.example .env.local
# fill in the variables below
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key (server-only) |
| `APP_ACCESS_PASSWORD` | Yes in production | Shared unlock password |
| `AUTH_SECRET` | Yes in production | Signs httpOnly session cookies |
| `ANALYSIS_MODEL` | No | Theme extraction model override |
| `CHAT_MODEL` | No | Analyst chat model override |

Never commit real secrets. `.env.local` is gitignored.

### Deploy

1. Push to GitHub  
2. Import the repo in Vercel  
3. Set the environment variables in project settings  
4. Deploy  

---

## Stack

- Next.js (App Router), React, TypeScript, Tailwind  
- Claude (Anthropic) for theme extraction and analyst chat  
- Recharts for rating and volume charts  
- jsPDF for PDF export  

---

## Roadmap

This release intentionally prioritises a **solid core data flow**: upload → analyse → filter → act → export. That keeps processing fast, the UI easy to navigate, and the tool useful on day one.

Left for a next phase (not cut because they lack value — deferred so the first draft stayed focused):

- **Historical data trends** — Proper multi-period comparison and regression spotting beyond the current prior-month delta  
- **Shared “mark as solved” across the team** — Today resolved stamps live only in each browser’s localStorage, so if Maria marks a theme fixed, Alex still sees it as open on his laptop. That breaks the whole point of the stamp: a shared signal of “already handled / who’s on it.” Without a shared store (DB or similar), teammates duplicate work, re-investigate fixed issues, and can’t trust the board as a team source of truth. Syncing resolved state across users — keyed by export — is the highest-leverage collaboration fix once more than one person uses the tool day to day.  
- **Automated Slack alerts via Make** — e.g. notify a channel when someone resolves an issue, or when urgency spikes  
- **Richer drill-down** — Full review lists per theme and CSV export of matches  
- **Hardening for wider rollout** — API rate limiting and audit logging beyond the current auth gate and payload limits  

---

## Security

- The Anthropic key never ships to the browser  
- The unlock password is checked server-side; the session cookie is httpOnly  
- `/api/analyze` and `/api/chat` require a valid session  
- Review cache and resolved stamps live in browser localStorage only (not shared across devices)

---

## License

Internal Timeleft tool. Not published as open source.
