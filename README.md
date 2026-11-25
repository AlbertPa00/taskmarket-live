# taskmarket-live

A live, server-cached market dashboard for [taskmarket.dev](https://taskmarket.dev) — the marketplace where agents and people post paid tasks and do them, on Tempo (OUSD) and Base (USDC).

Built for a paid Taskmarket bounty. **Not an official Taskmarket product.**

## What it shows

- Headline numbers: registered workers, active agents/workers (7d), open tasks, paid workers, active wallets — for Tempo, Base, or both chains.
- The flow over time: tasks posted, active agents and tasks completed per day, with 7d / 30d / 90d / all range switches.
- Money in, money out: daily reward volume posted into escrow vs paid out to winners.
- Tasks by status and by mode (bounty / claim / pitch / benchmark / auction).
- Distinct task posters per ISO week, computed from the public task list, plus the top requesters by tasks posted.
- Activity heatmap by hour of week and a live activity feed.

## Stack

Zero-dependency Node 18+ server (`server.mjs`) plus a single static page (`public/index.html`).
No build step, no npm packages, no client-side API calls — the browser only ever talks to this server.

## Data sources

All data comes from the public Taskmarket API (`https://api.taskmarket.dev/api`), fetched on the server:

- `/api/market/stats?chainId=…` — headline numbers
- `/api/stats/breakdowns?chainId=…` — tasks by status, mode, actor type
- `/api/stats/platform-time-series?chainId=…&range=all&bucket=day` — daily agents/tasks/rewards/payouts
- `/api/stats/activity-heatmap?chainId=…&range=30d&dimension=hourOfWeek|mode` — activity heatmap
- `/api/stats/activity-feed?chainId=…&limit=40` — live activity feed
- `/api/tasks?chainId=…&sort=newest&limit=100&cursor=…` — full task list (paginated), used for distinct-posters-per-week and top posters

The API does not allow cross-origin browser requests, which is why this server exists: it polls the API once per hour, caches the result in memory, and serves it at `GET /api/snapshot` (`Cache-Control: public, max-age=60`).

## Run it

```bash
node server.mjs        # serves on :8080 (PORT env to change)
```

One-command deploy (Fly.io, Dockerfile included):

```bash
fly deploy
```

or plain Docker:

```bash
docker build -t taskmarket-live . && docker run -p 8080:8080 taskmarket-live
```

`GET /healthz` returns `ok <asOf>` once the first snapshot is cached.

## Live instance

<https://taskmarket-live.fly.dev>

## Licence

MIT (see `LICENSE`). Fonts under the SIL Open Font License — licence texts in `public/fonts/`. Taskmarket mark/lockup are the bounty-provided brand assets.
