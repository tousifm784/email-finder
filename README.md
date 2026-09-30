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

Before starting Compose, set a unique `NEXTAUTH_SECRET` in `.env`; configure OAuth client IDs/secrets to enable Google or GitHub buttons. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` to deliver password recovery emails in production; without the key, development logs the one-hour reset link to the server console. Compose initializes a persistent SQLite file at `/data/signal.db`; local non-container setup uses `DATABASE_URL=file:./dev.db`, then run `npm run db:push`, start Redis, and run `npm run dev` and `npm run worker` in separate terminals. The worker reads `.env` through dotenv. For a multi-instance production deployment, move Prisma to PostgreSQL and use a managed shared database; the bundled SQLite configuration is for a single-host deployment.

Visitors can start without an account. The server issues an `HttpOnly` `signal_guest_session` cookie and stores up to 10 guest searches in SQLite. The 11th attempt opens the signup prompt. Credential or OAuth accounts receive 50 credits; each accepted lookup atomically consumes one credit and creates a history row. Queue submission failures refund the consumed use. Search jobs are scoped to either the authenticated user or the guest cookie; the API never trusts a client-supplied owner ID.

## Verification behavior

The worker normalizes names and domains, creates the ten ranked patterns in `lib/permutations.ts`, resolves MX records in preference order, and rejects non-public MX addresses before connecting. Direct SMTP probing is enabled by default with a five-second timeout; set `SMTP_PROBING_ENABLED=false` to opt out. It performs `EHLO`/`HELO`, `MAIL FROM`, a randomized `RCPT TO` catch-all gate, candidate `RCPT TO` checks, `RSET`, and `QUIT`. A catch-all acceptance stops candidate checks; candidates are tested only after the probe receives a definitive 550/551/553 response. The first candidate 250 stops the sequence. It never issues `DATA` and never sends a message. SMTP acceptance is an imperfect signal: gateways may defer checks or change policy later. A `250` is not a delivery guarantee.

Before network fallbacks, `data/company-intelligence.json` is checked for exact executive records and curated domain formulas. Those matches skip SMTP, external verifier, and public-search attempts; they are labeled as documented/formula matches, not live SMTP confirmation. Maintain this file as a curated knowledge base and verify its records before deployment.

For unknown people without a curated record, a blocked port, greylisting, inconclusive catch-all probe, or remote worker failure returns a risky/inconclusive result with no selected email. Candidate RCPT responses are labeled deliverable (250), invalid (550/551/553), or risky (421/450/451). An explicit external verifier may be configured as a secondary verification provider; an inconclusive provider response also returns no address. A randomized recipient accepted with 250 is reported as `Catch-all`; individual candidate checks do not run. Use this only for contacts and domains you are authorized to assess; results are not permission to send bulk email.

Public web scraping is best effort, bounded to two search requests per lookup with five-second timeouts and one-megabyte response caps. Configure `SEARCH_ENGINE_URL` to use an approved SearXNG-compatible endpoint. Search-engine markup/rate limits can change; low evidence falls back to the configured MX-provider estimate rather than being represented as online verification.

## SMTP worker deployment

Do not run direct SMTP on Vercel or another serverless runtime. Deploy the worker as a separate Docker service on a host with outbound TCP/25 available (for example, an appropriately configured VPS). AWS EC2 commonly blocks port 25 by default; request removal of the restriction before relying on this mode.

Before deploying direct SMTP probing:

1. Assign the worker a stable public IP and configure reverse DNS (PTR) for that IP to the exact `SMTP_HELO_DOMAIN` hostname.
2. Point that hostname back to the same public IP with an A/AAAA record; set `SMTP_FROM_ADDRESS` to an address at that HELO domain.
3. Confirm outbound TCP/25 is permitted by the provider and host firewall, then verify PTR and forward DNS externally.
4. Keep worker concurrency and rate limits conservative. The included BullMQ worker processes one job at a time and at most ten jobs per minute.

The code validates that the sender address uses the HELO domain; PTR correctness and the worker public IP are infrastructure responsibilities. The sample `.env.example` HELO identity is for development only; configure a domain you control before production. Some providers reject all automated SMTP recipient probing regardless of configuration.

Alternatively, set `SMTP_WORKER_URL` and optional `SMTP_WORKER_TOKEN`. The application posts JSON to that URL with a 20-second timeout, including a unique catch-all probe address:

```json
{ "domain": "example.com", "mxHost": "mx.example.com", "catchAllProbe": "catchall_probe_<uuid>@example.com", "candidates": ["alex@example.com"] }
```

The worker should require the bearer token when configured, probe `catchAllProbe` first, and return no candidate probes if it receives 250. It may return `{ "catchAll": false, "probes": [{ "email": "alex@example.com", "code": 250, "message": "Recipient accepted" }] }` only after the catch-all probe was rejected. Responses are restricted to submitted candidates. The remote worker must never issue `DATA` or send messages; validate provider policy and authorized use before enabling this bridge.

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

The authenticated API applies an eight-search-per-minute per-user limit and the queue worker has a ten-job-per-minute limiter. Configure OAuth secrets and a strong `NEXTAUTH_SECRET`; put the web app behind a trusted reverse proxy, and configure email verification, durable retention/deletion policies, and a managed PostgreSQL service before offering this broadly as a multi-tenant SaaS. Credential passwords require at least eight characters, including uppercase, lowercase, and a number. Password reset links expire after one hour and can be used once.