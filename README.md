# Signal Email Finder

An isolated Next.js application for authenticated business email pattern research. Prisma/SQLite stores accounts, credits, and search history; Redis/BullMQ keeps public web lookups and verification off HTTP requests. SMTP is disabled by default and can be delegated to an authenticated remote verification worker.

## Project structure

```text
email-finder/
  app/
    (auth)/login/page.tsx             # Credentials and configured social login
    (auth)/signup/page.tsx            # Registration and onboarding credits
    dashboard/page.tsx                # Account and credit overview
    history/page.tsx                  # Search history
    api/auth/[...nextauth]/route.ts
    api/auth/signup/route.ts
    api/account/route.ts
    api/searches/route.ts
    api/find-email/route.ts          # Enqueue a single lookup
    api/find-email/[jobId]/route.ts  # Poll job progress and result
    globals.css
    layout.tsx
    page.tsx
  components/
    finder-app.tsx                   # Search form, progress, result details
    query-provider.tsx
  lib/
    auth.ts                           # NextAuth providers and callbacks
    domain.ts                        # Domain validation
    pattern-discovery.ts             # Public pattern evidence and scoring
    prisma.ts                         # Prisma client
    permutations.ts                  # Name cleanup and email patterns
    provider-adapter.ts              # Optional API fallback adapters
    queue.ts                         # Redis/BullMQ setup
    smtp-verifier.ts                 # MX and no-DATA SMTP checks
  tests/permutations.test.ts
  worker/index.ts                    # Queue worker (deploy on a VPS for SMTP)
  docker-compose.yml
  Dockerfile
```

## Run locally

Requires Node.js 20+, npm, and Docker Compose.

```sh
cp .env.example .env
docker compose up --build
```

Before starting Compose, set a unique `NEXTAUTH_SECRET` in `.env`; configure OAuth client IDs/secrets to enable Google or GitHub buttons. Compose initializes a persistent SQLite file at `/data/signal.db`; local non-container setup uses `DATABASE_URL=file:./dev.db`, then run `npm run db:push`, start Redis, and run `npm run dev` and `npm run worker` in separate terminals. The worker reads `.env` through dotenv. For a multi-instance production deployment, move Prisma to PostgreSQL and use a managed shared database; the bundled SQLite configuration is for a single-host deployment.

New credential or OAuth accounts receive 25 credits. Each accepted lookup atomically consumes one credit and creates a history row. Queue submission failures refund that credit. A lookup is scoped to its authenticated owner; the API never trusts a client-supplied user ID.

## Verification behavior

The worker normalizes names and domains, creates ten ranked patterns (starting with `{first-initial}{last}` and `{first}.{last}`), resolves and sorts MX records, and rejects non-public MX addresses before connecting. When enabled, it performs `EHLO`/`HELO`, `MAIL FROM`, a randomized `RCPT TO` catch-all check, candidate `RCPT TO` checks, `RSET`, and `QUIT`. It never issues `DATA` and never sends a message. SMTP acceptance is an imperfect signal: gateways may accept all recipients, defer checks, or change policy later. A `250` is not a delivery guarantee.

When SMTP is disabled or port 25 is blocked/times out, the worker searches public DuckDuckGo HTML results for visible addresses on the domain. Two or more distinct addresses matching a local-part structure produce 92%+ pattern confidence and a `Pattern Verified (Online Match)` badge; this is evidence for a company-wide format, not evidence that the named person's mailbox exists. If no pattern evidence is found, an MX-provider heuristic returns a 65% estimate. Predictions include the ten ranked copyable patterns. Known LinkedIn, Google, Microsoft, Proofpoint, and Mimecast gateways that accept all recipients or reject probes with 421/554 receive an `Enterprise Protected / Predicted Pattern` badge. A randomized recipient accepted with a 2xx response is reported as `Catch-all`; mailbox-level confirmation is not possible from that check. Use this only for contacts and domains you are authorized to assess; results are not permission to send bulk email.

Public web scraping is best effort, bounded to two search requests per lookup with five-second timeouts and one-megabyte response caps. Configure `SEARCH_ENGINE_URL` to use an approved SearXNG-compatible endpoint. Search-engine markup/rate limits can change; low evidence falls back to the 65% estimate rather than being represented as online verification.

## SMTP worker deployment

Do not enable direct SMTP on Vercel or another serverless runtime. Deploy the worker as a separate Docker service on a host with outbound TCP/25 available (for example, an appropriately configured VPS). AWS EC2 commonly blocks port 25 by default; request removal of the restriction before enabling this mode.

Before setting `SMTP_PROBING_ENABLED=true`:

1. Assign the worker a stable public IP and configure reverse DNS (PTR) for that IP to the exact `SMTP_HELO_DOMAIN` hostname.
2. Point that hostname back to the same public IP with an A/AAAA record; set `SMTP_FROM_ADDRESS` to an address at that HELO domain.
3. Confirm outbound TCP/25 is permitted by the provider and host firewall, then verify PTR and forward DNS externally.
4. Keep worker concurrency and rate limits conservative. The included BullMQ worker processes one job at a time and at most ten jobs per minute.

The code validates that the sender address uses the HELO domain; PTR correctness and the worker public IP are infrastructure responsibilities. Some providers reject all automated SMTP recipient probing regardless of configuration.

Alternatively, set `SMTP_WORKER_URL` and optional `SMTP_WORKER_TOKEN`. The application posts JSON to that URL with a 20-second timeout:

```json
{ "domain": "example.com", "mxHost": "mx.example.com", "candidates": ["alex@example.com"] }
```

The worker should require the bearer token when configured and return `{ "catchAll": false, "probes": [{ "email": "alex@example.com", "code": 250, "message": "Recipient accepted" }] }`. Responses are restricted to submitted candidate addresses. The remote worker must never issue `DATA` or send messages; validate provider policy and authorized use before enabling this bridge.

## Optional API fallback

Set one provider and its API key in `.env` to use an external verifier when SMTP is disabled or inconclusive:

```dotenv
FALLBACK_PROVIDER=millionverifier
MILLIONVERIFIER_API_KEY=...
```

Supported `FALLBACK_PROVIDER` values are `millionverifier`, `zerobounce`, and `hunter`; use only the matching key. Provider usage may incur per-address costs. Keys are read only by the worker and are never sent to the browser.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

The authenticated API applies an eight-search-per-minute per-user limit and the queue worker has a ten-job-per-minute limiter. Configure OAuth secrets and a strong `NEXTAUTH_SECRET`; put the web app behind a trusted reverse proxy, and configure email verification, account recovery, durable retention/deletion policies, and a managed PostgreSQL service before offering this broadly as a multi-tenant SaaS. The current password flow does not send verification or recovery email.