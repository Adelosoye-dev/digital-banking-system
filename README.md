# Digital Banking System

Core backend for a start-up bank, built on **Express + MongoDB** and integrated with the
**NibssByPhoenix** core-banking APIs.

It covers the full customer journey — registration, BVN/NIN onboarding, account opening with
pre-funding, name enquiry, intra- and inter-bank transfers, balance and transaction status
checks — with per-customer data isolation enforced at the query layer.

---

## Quick start

```bash
cd digital-banking-system
npm install
npm run dev                 # http://localhost:4000
```

This bank is already onboarded with NibssByPhoenix as **FET Bank**, bank code **600**
(registered as "Fetchit Bank of Africa"), and `.env` holds the working API key and
secret. `npm run onboard` only needs running once, for a brand-new bank.

Interactive API docs: **http://localhost:4000/docs**
Health check: **http://localhost:4000/api/v1/health**

Verify the provider credentials took effect:

```bash
curl http://localhost:4000/api/v1/health/provider
# -> { "reachable": true, ... }
```

### Requirements

| | |
|---|---|
| Node.js | 18+ (tested on 20) |
| MongoDB | 6+ running locally, or a MongoDB Atlas URI in `MONGODB_URI` |

A standalone `mongod` is fine — the ledger uses conditional atomic updates rather than
multi-document transactions, so no replica set is required.

---

## The onboarding funnel

Each step is enforced by the API. Skipping one returns a specific error code, not a generic 400.

```
POST /auth/register          ->  nextStep: COMPLETE_KYC
POST /kyc/bvn  (or /kyc/nin) ->  nextStep: CREATE_ACCOUNT     [403 KYC_REQUIRED if skipped]
POST /accounts               ->  nextStep: READY              [409 ACCOUNT_LIMIT_REACHED on a second]
GET  /accounts/name-enquiry/:accountNumber
POST /transfers
```

**Identity numbers are synthetic.** Omit `bvn` / `nin` in the request body and the service mints
a random 11-digit test value, creates it at NibssByPhoenix via `insertBvn` / `insertNin`, then
immediately validates it with `validateBvn` / `validateNin`. KYC is only marked `VERIFIED` when
validation passes — creation alone is not enough. No real BVN or NIN is ever used.

**Pre-funding.** A new account is opened with ₦15,000 and the funding is written to the ledger as
an `OPENING_CREDIT` transaction, so the opening balance is auditable rather than a magic number.

---

## Walkthrough

```bash
BASE=http://localhost:4000/api/v1

# 1. register
TOKEN=$(curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' -d '{
  "firstName":"John","lastName":"Doe","email":"john@example.com",
  "phone":"08012345678","dateOfBirth":"1995-06-15","password":"Passw0rd1"
}' | jq -r .data.tokens.accessToken)

# 2. KYC - identity details default to the registered profile
curl -s -X POST $BASE/kyc/bvn -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'

# 3. open the account (pre-funded with NGN 15,000)
curl -s -X POST $BASE/accounts -H "Authorization: Bearer $TOKEN"

# 4. balance
curl -s $BASE/accounts/balance -H "Authorization: Bearer $TOKEN"

# 5. name enquiry before sending
curl -s $BASE/accounts/name-enquiry/0123456789 -H "Authorization: Bearer $TOKEN"

# 6. transfer
curl -s -X POST $BASE/transfers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "destinationAccountNumber":"0123456789","amount":2500,"narration":"Lunch"
}'

# 7. status check + history
curl -s $BASE/transactions/TRX-XXXX-XXXX -H "Authorization: Bearer $TOKEN"
curl -s "$BASE/transactions?page=1&limit=20" -H "Authorization: Bearer $TOKEN"
```

There is also an automated walkthrough that exercises every requirement against a running server:

```bash
npm start                                    # terminal 1
npm run smoke                                # terminal 2
npm run smoke -- --external 0123456789       # include an inter-bank leg to a colleague account
```

---

## Endpoints

All routes are prefixed with `/api/v1`. Everything except `register`, `login`, `refresh` and the
health checks requires `Authorization: Bearer <accessToken>`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Liveness, DB state, whether provider credentials are set |
| `GET` | `/health/provider` | Actually authenticates against NibssByPhoenix |
| `POST` | `/auth/register` | Create a customer |
| `POST` | `/auth/login` | Access + refresh tokens |
| `POST` | `/auth/refresh` | New access token |
| `GET` | `/auth/me` | Profile, account and `nextStep` |
| `POST` | `/auth/change-password` | Revokes all existing sessions |
| `GET` | `/kyc/status` | Masked identifier, verification state |
| `POST` | `/kyc/bvn` | Create + verify a test BVN |
| `POST` | `/kyc/nin` | Create + verify a test NIN |
| `POST` | `/kyc/verify` | Link a BVN/NIN that already exists at the provider |
| `POST` | `/accounts` | Open the account — requires verified KYC |
| `GET` | `/accounts/me` | Your account |
| `GET` | `/accounts/balance` | Live from the provider; `?refresh=false` reads the ledger |
| `GET` | `/accounts/name-enquiry/:accountNumber` | Resolves the beneficiary and classifies the route |
| `POST` | `/transfers` | Intra- or inter-bank, decided automatically |
| `GET` | `/transactions` | Your history — paginated and filterable |
| `GET` | `/transactions/summary` | Your totals |
| `GET` | `/transactions/:reference` | Status check; settles pending transfers |

`postman_collection.json` in the project root imports the whole flow, with the access token
captured automatically after register/login.

---

## How transfers work

**Intra vs inter-bank is inferred, not declared.** Name enquiry first checks whether the
destination account number belongs to this bank. If it does, the transfer is `INTRA_BANK_TRANSFER`
and the beneficiary gets a real `CREDIT` entry in their own history. If it does not, the account is
resolved through NibssByPhoenix and the transfer is `INTER_BANK_TRANSFER`.

**The source account cannot be forged.** There is no `from` field in the request body — the source
is resolved from the JWT by the `requireAccount` middleware.

**Reserve, then commit.** A slow or failed provider call can never leave the ledger overdrawn:

```
1. resolve the destination and classify the route
2. RESERVE          lockedBalance += amount      (single conditional $inc; fails if
                                                  balance - lockedBalance < amount)
3. write a PENDING debit leg
4. call NibssByPhoenix
5a. success       -> COMMIT    balance -= amount, lockedBalance -= amount
5b. declined      -> RELEASE   lockedBalance -= amount, leg marked FAILED
5c. indeterminate -> HOLD      funds stay locked, leg marked PROCESSING, HTTP 202
```

Case 5c is the one that matters. When the provider times out we genuinely do not know whether the
money moved, so the funds stay locked — unspendable but not yet deducted — and
`GET /transactions/:reference` reconciles against the provider and settles the ledger either way.

**Money is stored as integer kobo**, converted to naira only at the provider boundary, so
`1.10 + 2.20` is exactly `330` kobo with no floating-point drift.

**Idempotency.** Pass `idempotencyKey` in the body or an `Idempotency-Key` header and a repeated
request returns the original transaction instead of sending twice. A unique partial index on
`(customer, idempotencyKey)` makes this safe against concurrent duplicates, not just sequential ones.

---

## Data privacy

Requirement 4 of the brief, enforced structurally rather than by convention:

- **Every query starts from the owner.** Reads in `transactions.service.js` begin with
  `{ customer: customer._id }`; the account services resolve accounts by `customer`, never by an
  id from the URL. There is no code path that fetches a transaction by reference alone.
- **404, not 403.** Requesting another customer's transaction reference returns
  `404 TRANSACTION_NOT_FOUND` — a 403 would confirm the reference exists.
- **Name enquiry returns a counterparty projection only** — account number, name, bank. Never a
  balance, an owner, or an internal id.
- **Identity numbers are masked** everywhere they are echoed back (`761******14`), and the raw
  provider response is `select: false` so it cannot leak through a stray `.find()`.
- **Password hashes are stripped** in `toJSON` and the field is `select: false`.
- **Changing a password bumps `tokenVersion`**, which invalidates every token issued before it.

The isolation test suite asserts all of this, including that a valid token from customer B cannot
reach customer A's transaction, summary, or account.

---

## Project structure

```
src/
├── config/           env validation (zod), mongo connection, pino logger
├── models/           Customer, Account, Transaction, shared enums
├── middleware/       auth + KYC/account gates, validation, rate limits,
│                     mongo-operator sanitiser, error handler
├── integrations/
│   └── nibss/        client.js    - token caching, 401 re-auth, retries, error mapping
│                     nibss.service.js - domain wrapper, response normalisation
├── modules/
│   ├── auth/         register, login, refresh, change password
│   ├── kyc/          BVN / NIN creation and verification
│   ├── accounts/     creation, balance, name enquiry
│   ├── transfers/    the reserve-commit ledger flow
│   └── transactions/ history, status checks, settlement
├── docs/openapi.js   the spec served at /docs
├── routes/index.js   route table + health
├── app.js            middleware pipeline
└── server.js         bootstrap + graceful shutdown

scripts/              onboard-fintech.js, smoke-test.js
tests/                50 tests over onboarding, transfers and isolation
```

Each module is `routes -> controller -> service`, with validators alongside. Controllers do no
business logic; services never touch `req` or `res`.

---

## Provider integration

`src/integrations/nibss/client.js` is the only place that speaks HTTP to NibssByPhoenix:

- Caches the bearer token and reads its real `exp` claim, refreshing 60s early
- Collapses concurrent callers onto a single token request
- Re-authenticates once on a `401`, then gives up rather than looping
- Retries transport failures with exponential backoff — Render free instances cold-start slowly
- Maps upstream errors into our own vocabulary. An upstream `401` becomes a `502` on our side,
  because it means *our* credentials are wrong, not the caller's

`nibss.service.js` normalises the responses, so business logic never guesses at field names
(`accountNumber` vs `account_number` vs `nuban`) or status spellings (`SUCCESSFUL`, `00`, `COMPLETED`).

| Ours | Theirs |
|---|---|
| `POST /kyc/bvn` | `POST /api/insertBvn` + `POST /api/validateBvn` |
| `POST /kyc/nin` | `POST /api/insertNin` + `POST /api/validateNin` |
| `POST /accounts` | `POST /api/account/create` |
| `GET /accounts/name-enquiry/:n` | `GET /api/account/name-enquiry/{accountNumber}` |
| `GET /accounts/balance` | `GET /api/account/balance/{accountNumber}` |
| `POST /transfers` | `POST /api/transfer` |
| `GET /transactions/:ref` | `GET /api/transaction/{ref}` |

---

## Tests

```bash
npm test
```

50 tests, no network access — the provider is replaced by an in-memory fake that mirrors its
contract, so the suite is deterministic and runs offline.

```
tests/onboarding.test.js   registration, the KYC gate, account creation, pre-funding, balances
tests/transfers.test.js    name enquiry, intra/inter-bank, guard rails, idempotency, settlement
tests/isolation.test.js    data privacy, auth, session revocation, injection, pagination
```

Notable cases: a declined transfer releases the reservation and leaves the balance untouched; an
unreachable provider holds the funds locked and returns 202; a held transfer settles correctly
once the provider confirms; `{"email": {"$ne": null}}` cannot be used to log in.

---

## Security

| | |
|---|---|
| Passwords | bcrypt, 12 rounds, `select: false`, complexity enforced |
| Sessions | JWT with issuer/audience checks, DB lookup per request, `tokenVersion` revocation |
| Injection | Mongo operator keys stripped from body, params and query; regex input escaped |
| Rate limits | 100/min globally, 10/min on credentials, 20/min per customer on transfers |
| Headers | helmet, CORS allowlist, `x-powered-by` disabled |
| Payloads | 100kb cap, `.strict()` schemas reject unknown fields |
| Logging | Authorization headers, passwords, API secrets and tokens redacted |
| Errors | 5xx bodies carry no stack or internal detail in production |

---

## Configuration

Copy `.env.example` to `.env`. A `.env` with generated JWT secrets is already in place; only the
two NibssByPhoenix credentials need filling in.

| Variable | Default | |
|---|---|---|
| `PORT` | `4000` | |
| `API_PREFIX` | `/api/v1` | |
| `BANK_NAME` | `FET Bank` | Name registered with NibssByPhoenix |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/digital_banking` | |
| `JWT_SECRET` | *(generated)* | Min 16 chars |
| `JWT_EXPIRES_IN` | `1h` | |
| `NIBSS_API_KEY` / `NIBSS_API_SECRET` | *(empty)* | **From the onboarding email** |
| `NIBSS_MAX_RETRIES` | `3` | Render cold starts |
| `OPENING_BALANCE_KOBO` | `1500000` | ₦15,000 pre-funding |
| `MAX_ACCOUNTS_PER_CUSTOMER` | `1` | |
| `MIN_TRANSFER_KOBO` / `MAX_TRANSFER_KOBO` | `100` / `100000000` | ₦1 – ₦1,000,000 |

Startup validates every variable with zod and exits with a readable list if anything is wrong,
rather than failing later with `undefined`.

---

## Error codes

| Code | Status | |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Includes a per-field `details` array |
| `INVALID_CREDENTIALS` | 401 | |
| `TOKEN_EXPIRED` / `TOKEN_INVALID` / `TOKEN_REVOKED` | 401 | |
| `KYC_REQUIRED` | 403 | Account creation or transfer attempted before verification |
| `KYC_ALREADY_VERIFIED` | 409 | |
| `KYC_IDENTIFIER_TAKEN` | 409 | Another customer already claims that BVN/NIN |
| `ACCOUNT_LIMIT_REACHED` | 409 | One account per customer |
| `ACCOUNT_NOT_FOUND` | 404 | |
| `SELF_TRANSFER` / `SELF_ENQUIRY` | 400 | |
| `INSUFFICIENT_FUNDS` | 402 | Returns requested vs available |
| `TRANSFER_DECLINED` | 422 | Provider rejected it; funds released |
| `TRANSACTION_NOT_FOUND` | 404 | Also returned for another customer's reference |
| `PROVIDER_NOT_CONFIGURED` | 503 | `NIBSS_API_KEY` / `NIBSS_API_SECRET` not set |
| `PROVIDER_UNREACHABLE` | 503 | |
| `RATE_LIMITED` | 429 | |

---

## Deployment (Render free tier + MongoDB Atlas)

`render.yaml` is a Render Blueprint, so the service, health check and all
non-secret environment variables are provisioned from this repo. Three secrets are
never committed and are pasted once in the Render UI: `MONGODB_URI`,
`NIBSS_API_KEY`, `NIBSS_API_SECRET`. The two JWT secrets are generated by Render
itself (`generateValue: true`), so nobody ever handles them.

### 1. MongoDB Atlas (free M0)

1. https://cloud.mongodb.com -> sign up -> **Create** a free **M0** cluster.
2. **Database Access** -> Add New Database User. Username `fetbank`, generate a
   password, role **Read and write to any database**. Save the password.
3. **Network Access** -> Add IP Address -> **Allow access from anywhere**
   (`0.0.0.0/0`). Render's free tier has no static outbound IP, so an allowlist
   of specific addresses will not work.
4. **Connect** -> **Drivers** -> copy the SRV string, then insert the password and
   the database name:

   ```
   mongodb+srv://fetbank:<password>@<cluster>.mongodb.net/digital_banking?retryWrites=true&w=majority
   ```

   The `/digital_banking` path segment matters - without it you get the `test` database.

### 2. Push to GitHub

```bash
git remote add origin https://github.com/<you>/digital-banking-system.git
git push -u origin main
```

### 3. Render

1. https://dashboard.render.com -> **New** -> **Blueprint** -> select the repo.
2. Render reads `render.yaml` and prompts for the three `sync: false` values.
   Paste the Atlas URI and your two NibssByPhoenix credentials.
3. **Apply**. First build takes 2-4 minutes.

Then verify:

```bash
BASE=https://fet-bank-api.onrender.com
curl $BASE/api/v1/health              # database: "connected"
curl $BASE/api/v1/health/provider     # reachable: true
npm run smoke -- --base $BASE         # full 14-step walkthrough against production
```

Docs are live at `$BASE/docs`.

### Free-tier behaviour worth knowing

- **Cold starts.** A free Render instance sleeps after ~15 minutes idle and takes
  ~50s to wake. The first request after idling will feel slow; this affects the
  grader too, so warm it up before demoing.
- **The provider sleeps as well.** NibssByPhoenix is itself on Render free, which is
  why `NIBSS_TIMEOUT_MS` is raised to 45s and `NIBSS_MAX_RETRIES` to 4 in
  `render.yaml` - the client retries transport failures with exponential backoff, so
  a provider cold start surfaces as a slow success rather than an error.
- **Indexes.** `autoIndex` is off in production, so `ensureIndexes()` runs at boot to
  build them explicitly. A fresh Atlas database has no indexes, and the uniqueness
  this system depends on - one email, one account number, one transaction reference,
  one idempotency key per customer - lives entirely in them.

## Notes and known limits

- **Provider credentials are required for account creation and transfers.** The BVN/NIN endpoints
  are public on the provider side and work without them; everything under `/api/account`,
  `/api/transfer` and `/api/transaction` needs the key and secret from the onboarding email.
- **The provider is the system of record for money.** `Account.balance` is a mirror that is
  reconciled on every balance enquiry; drift is logged and resolved in the provider's favour.
- **Balance falls back to the ledger** if the provider is unreachable, flagged `stale: true` — a
  provider outage should not hide a customer's money from them.
- **`OPENING_BALANCE_KOBO` is a fallback.** If the provider reports a balance on the new account,
  that value wins; the configured ₦15,000 is only used when it reports none.
