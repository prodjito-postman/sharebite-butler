# sharebite-butler

A personal chat agent that plans, places, and cancels your daily
[Sharebite](https://www.sharebite.com/) lunch orders. It pulls the week's
menus from your corporate Sharebite tenant, recommends a meal that uses your
allowance well (factoring in your past orders and Sharebite's own restaurant
ratings), and — on request — actually submits the order to Sharebite using
the credit card you have on file.

Built on [Astropods](https://astropods.com) + [Mastra](https://mastra.ai),
running Claude under the hood.

> **Status:** personal tool. Hard-coded to `postman.sharebite.com`. If you
> work at a different company, change `ORIGIN` in `ingestion/lib/sharebite.ts`
> to your tenant. Everything else should work.

## What it does

A typical conversation with the agent:

```
You: what should I order for Friday?
Bot: Caspian Cuisine looks like the better pick — your past orders there
     were strong, and the lamb koobideh hits 92% of your $30 allowance.

     • Lamb Koobideh — $27.50
     Subtotal: $27.50 (under budget by $2.50)

You: place it
Bot: Here's the order at Caspian Cuisine for Fri Jun 12:
       • Lamb Koobideh — $27.50
     Subtotal:  $27.50
     Allowance: -$30.00
     Tax:        $2.45 (paid by employer)
     YOU PAY:   $0.00
     Reply "place order" to confirm.

You: place order
Bot: Done — order #SB-4837291 confirmed at Caspian Cuisine.
```

Tools the agent has access to:

| Tool | Purpose |
|---|---|
| `list_available_menu_dates` | Which dates have cached menu data |
| `get_menu_for_date` | Full menu + past orders + allowance for a date |
| `get_item_modifiers` | Fetch required/optional modifiers for an item |
| `dry_run_order` | Price quote from Sharebite (subtotal, tax, your out-of-pocket) |
| `place_order` | Submit the order (requires literal `"place order"` confirmation) |
| `list_placed_orders` | Active orders from Sharebite (any source — agent, web UI, mobile) |
| `cancel_order` | Cancel an order by date |

Safety rails baked in:

- **Overage cap** — `place_order` refuses any order whose out-of-pocket cost
  exceeds `MAX_OVERAGE_USD` (default $5). Trim the cart or place it yourself
  in the Sharebite UI.
- **Confirmation token** — `place_order` requires the literal string
  `place order`. Saying "yes" or "ok" won't trigger it.
- **No drinks** — drinks are excluded from recommendations.
- **130% subtotal cap** — recommendations stay under 130% of the day's
  allowance.

## Prerequisites

- [Bun](https://bun.sh) 1.1+
- [Astropods CLI](https://docs.astropods.com) (`ast`) — provides the local
  Redis container and the chat playground
- An active Sharebite session at `postman.sharebite.com` (Okta SSO)
- An [Anthropic API key](https://console.anthropic.com/settings/keys)

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Grab your Sharebite cookies

Sharebite has no public API, so the agent calls its internal endpoints
using your authenticated browser session. You need **two cookies**:

| Cookie | Env var | Lifetime | When to refresh |
|---|---|---|---|
| `sessionid` | `SHAREBITE_SESSION_COOKIE` | 8–24 hours | When the agent returns 401 / "session not authenticated" |
| `csrftoken` | `SHAREBITE_CSRF_TOKEN` | ~1 year | When `cancel_order` returns 403 / "CSRF check failed" |

To grab them:

1. Sign into <https://postman.sharebite.com> in Chrome (Okta SSO).
2. DevTools → **Application** → **Cookies** → `https://postman.sharebite.com`.
3. Copy both values.

### 3. Write your `.env`

```bash
cat > .env <<EOF
SHAREBITE_SESSION_COOKIE=<sessionid value>
SHAREBITE_CSRF_TOKEN=<csrftoken value>
ANTHROPIC_API_KEY=<your anthropic key>
# Optional: cap how much out-of-pocket the agent will spend per order (default 5)
# MAX_OVERAGE_USD=10
EOF
```

`.env` is gitignored — do not commit it.

### 4. Start the local stack

```bash
ast project start
```

This brings up:
- The agent (gRPC server on the Astropods messaging port)
- Redis at `localhost:6379` (stores cached menus)
- The chat playground at <http://localhost:3100>

### 5. Pull this week's menus

```bash
bun ingest
```

This fetches every weekday's group order from Sharebite and writes the
menus to Redis under `dayplan:YYYY-MM-DD` keys.

> Today the agent does **not** auto-ingest. Run `bun ingest` once a week
> (Monday morning is the natural cadence). A future change will let the
> chat agent trigger ingestion itself — tracked in
> `project_astro_deploy_plan.md`.

### 6. Use it

Open <http://localhost:3100> and chat with the agent. Or, for a one-shot
recommendation rundown of every cached day, use the CLI:

```bash
bun recommend                # all upcoming cached days
bun recommend 2026-06-12     # a single day
```

The CLI is read-only (no ordering) and prints to stdout.

## Configuration

All configuration lives in `astropods.yml` (declared inputs) and `.env`
(values). The agent reads:

| Env var | Required? | Used by | Notes |
|---|---|---|---|
| `SHAREBITE_SESSION_COOKIE` | yes | ingestion + all tools | Refresh daily |
| `SHAREBITE_CSRF_TOKEN` | yes for cancel/place | `place_order`, `cancel_order` | Refresh yearly |
| `ANTHROPIC_API_KEY` | yes | Claude model API | |
| `MAX_OVERAGE_USD` | no (default 5) | `place_order` | Hard cap on out-of-pocket spend |
| `REDIS_URL` / `REDIS_HOST`+`REDIS_PORT` | no | menu cache | Defaults to `redis://localhost:6379` (the Astropods container) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | tracing | Defaults to `http://localhost:4318` |

## Project structure

```
sharebite-butler/
├── agent/
│   ├── index.ts          # gRPC entry point (used by `ast project start`)
│   ├── cli.ts            # `bun recommend` — terminal recommendations
│   └── lib.ts            # Agent factory, tools, instructions
├── ingestion/
│   ├── lib/
│   │   ├── schemas.ts    # Zod schemas for Sharebite API responses
│   │   ├── sharebite.ts  # SharebiteClient — REST wrapper
│   │   └── store.ts      # Redis-backed day-plan store
│   ├── manual/index.ts   # `bun ingest` — pull this week's menus
│   └── schedule/index.ts # (stub — will be removed; see deploy plan)
├── astropods.yml         # Astropods agent + ingestion config
├── Dockerfile            # Agent container
├── .env                  # Secrets (gitignored)
└── package.json
```

## How recommendations work

For each weekday the menu cache holds a "day plan": two restaurants, their
menus, the user's allowance for that day, and the user's previous orders
at each restaurant. The agent picks **one** restaurant and an item
combination using these rules:

1. Subtotal must be ≤ 130% of the allowance.
2. Prefer a single-dish lunch landing at 70–100% of budget; otherwise a
   lunch + dinner pair totalling 70–130%.
3. No drinks.
4. Prefer expensive proteins (salmon > chicken > tofu) at the same price.
5. Past-ordered items are positive signal — but avoid repeating the most
   recent item from that restaurant. Favor variety.

You can adjust these rules in the `AGENT_INSTRUCTIONS` block in
`agent/lib.ts`.

## Order placement flow

```
get_menu_for_date(date)
  └─ user asks for recommendation
       └─ get_item_modifiers(...)            # if needed
            └─ dry_run_order(...)            # get real prices from Sharebite
                 └─ agent presents order to user
                      └─ user replies "place order"
                           └─ place_order(...)
                                └─ Sharebite confirms; email arrives
```

The agent uses Sharebite's saved credit card to pay any overage — there's
no token handling in this codebase. Sharebite resolves the saved card
server-side from the `is_selected_card` flag on the user's account.

## Forking for a different Sharebite tenant

1. Change `ORIGIN` in `ingestion/lib/sharebite.ts:25` from
   `https://postman.sharebite.com` to your tenant.
2. Same in `ingestion/manual/index.ts` setup instructions.
3. Re-grab cookies from your tenant.
4. Run `bun ingest`.

The Sharebite REST surface itself doesn't vary by tenant — endpoints,
shapes, and auth model are all the same.

## License

Personal project, no license. Fork freely for personal use.
