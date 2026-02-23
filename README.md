# Claude Analytics

**See where your Claude Code tokens go. One command, zero setup.**

Claude Analytics reads your local Claude Code session data and serves an interactive dashboard showing exactly where your tokens are being consumed.

## Quick Start

```bash
npx claude-code-usage-analytics
```

That's it. Your browser opens with a full analytics dashboard.

## Features

- **Usage Breakdown** - Every conversation ranked by token consumption with per-message drilldowns
- **Smart Insights** - Actionable tips personalized to your usage patterns (vague prompts, long sessions, model mismatches)
- **Daily Charts** - Visualize token usage over time with stacked bar charts (input vs output)
- **Model Comparison** - Token split across Opus, Sonnet, and Haiku with donut chart
- **Project Analytics** - Per-project breakdown with expandable drawers showing top prompts and tool usage
- **Most Expensive Prompts** - Top 20 costliest individual messages ranked
- **Session Explorer** - Sortable, searchable table of all conversations with click-to-drilldown
- **100% Private** - Everything runs locally. No data leaves your machine.

## How It Works

1. Claude Code stores session data in `~/.claude/projects/` as JSONL files
2. Claude Analytics reads and parses these files locally
3. A local Express server serves the dashboard at `http://localhost:3456`
4. Your browser opens automatically with the full analytics view

## Options

```bash
npx claude-code-usage-analytics                    # Default: opens on port 3456
npx claude-code-usage-analytics --port 8080        # Custom port
npx claude-code-usage-analytics --no-open          # Don't auto-open browser
npx claude-code-usage-analytics --help             # Show help
```

## Project Structure

```
ClaudeAnalaytics/
├── homepage/              # Landing page (deployed on Vercel)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/                   # NPX tool
│   ├── index.js           # CLI entry point
│   ├── server.js          # Express API server
│   ├── parser.js          # Session parser + insight generation
│   └── public/            # Dashboard UI
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── vercel.json            # Vercel deployment config
└── package.json
```

## Dashboard Sections

| Section | What it shows |
|---------|--------------|
| Stats Cards | Total tokens, conversations, messages, output ratio |
| Insights | Personalized warnings about vague prompts, long sessions, model waste |
| Daily Chart | Stacked bar chart of input/output tokens per day |
| Model Donut | Token distribution across Opus, Sonnet, Haiku |
| Projects | Per-project usage with expandable prompt details |
| Top Prompts | 20 most expensive individual prompts |
| Sessions | Full sortable/searchable session table |
| Drilldown | Click any session to see every message and its token cost |

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla HTML/CSS/JS, Canvas charts
- **Theme**: Dark mode with glassmorphism
- **Deployment**: Vercel (landing page)

## Privacy

All data stays on your machine. The tool reads `~/.claude/` locally and serves a dashboard on localhost. Nothing is sent to any external server.

## License

MIT

## Author

Made with love by [Bishal](https://bishalde.vercel.app/)

- [LinkedIn](https://www.linkedin.com/in/bishalde/)
- [GitHub](https://github.com/bishalde)
