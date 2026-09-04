# Selebration Server — Architecture

## Overview

Selebration is a **Nigerian affiliate-marketing + e-learning platform**. Users pay a subscription fee (in Naira via Paystack), get access to course content, earn referral commissions by recruiting others, and can withdraw their earnings. The server is a TypeScript/Express REST API backed by MongoDB, with Socket.IO for real-time events and node-cron for scheduled jobs.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (ESM, `"type": "module"`, NodeNext resolution) |
| Runtime | Node.js 20 |
| Framework | Express 4 |
| Database | MongoDB via Mongoose 8 |
| Real-time | Socket.IO 4 |
| Payments | Paystack (NGN) |
| Auth | JWT (jsonwebtoken) + bcryptjs |
| Email | Nodemailer → Gmail SMTP |
| Scheduler | node-cron |
| File uploads | Multer |
| Security | Helmet, express-rate-limit, CORS allowlist |
| Container | Docker (multi-stage, node:20-alpine, non-root user) |
| Reverse proxy | Caddy 2 (TLS termination) |
| CI/CD | GitHub Actions → GHCR on `production` branch |

---

## Repository Layout

```
src/
├── index.ts                  # Entry point — Express + Socket.IO + MongoDB bootstrap
├── socket.ts                 # Socket.IO initialisation and room helpers
├── seed.ts                   # DB seed script
├── config/
│   └── email.ts              # Recovery email constant
├── middleware/
│   ├── auth.ts               # Admin JWT guard (roles: admin, superadmin)
│   ├── userAuth.ts           # User JWT guard (roles: student, affiliate)
│   └── asyncHandler.ts       # Wraps async handlers to forward errors to Express
├── models/
│   ├── index.ts              # Barrel re-export of all models
│   ├── User.ts
│   ├── Admin.ts
│   ├── Course.ts
│   ├── Commission.ts
│   ├── Withdrawal.ts
│   ├── Settings.ts
│   ├── Notification.ts
│   ├── ChatMessage.ts
│   ├── ModuleUnlock.ts
│   ├── Announcement.ts
│   └── UsedReference.ts
├── routes/
│   ├── index.ts              # Aggregates all routers
│   ├── upload.route.ts       # Multer file upload
│   ├── user/
│   │   ├── auth.route.ts
│   │   ├── student.route.ts
│   │   ├── payment.route.ts
│   │   ├── chat.route.ts
│   │   └── notification.route.ts
│   └── admin/
│       ├── auth.route.ts
│       ├── user.route.ts
│       ├── course.route.ts
│       ├── commission.route.ts
│       ├── withdrawal.route.ts
│       ├── dashboard.route.ts
│       ├── analytics.route.ts
│       ├── settings.route.ts
│       ├── announcement.route.ts
│       ├── notification.route.ts
│       ├── emailBlast.route.ts
│       ├── chat.route.ts
│       └── admin-management.route.ts
├── jobs/
│   ├── trialReminder.ts
│   ├── payoutReminder.ts
│   └── subscriptionExpiry.ts
└── utils/
    ├── mailer.ts
    └── distributeCommissions.ts
```

---

## Data Models

### User
Core entity for students and affiliates.

| Field | Type | Notes |
|---|---|---|
| name, email, phone | String | email is unique, lowercase |
| password | String | bcrypt hash |
| role | `student \| affiliate \| admin` | default: student |
| referralCode | String | unique, format: `SELL-XXXXXX` |
| referredBy | String | referralCode of referrer |
| stage | Number | 0=none, 1=fish, 2=shark, 3=whale |
| subscription | `trial \| active \| expired \| cancelled` | default: trial |
| trialEndsAt | Date | set to +7 days on registration; +1 month on each payment |
| status | `active \| banned` | |
| referrals | Number | direct referral count |
| bankName/bankCode/accountNumber/accountName | String | for withdrawals |

### Admin
Separate collection for admin panel users (not merged with User).

| Field | Type | Notes |
|---|---|---|
| name, email, password | String | |
| role | `admin \| superadmin` | |

### Course
E-learning content. Divided into four stage tiers, each holding videos.

| Field | Notes |
|---|---|
| title, description, thumbnail | |
| status | `active \| inactive` |
| whatYouLearn | String array |
| stages | Array of `{ stage: free\|fish\|shark\|whale, videos: [{title, description, videoUrl, orderIndex}] }` |

### Commission
Created automatically by `distributeCommissions()` whenever a payment is verified.

| Field | Notes |
|---|---|
| payer | userId of subscriber |
| beneficiary | userId of affiliate receiving the commission |
| level | 1–6 in the referral chain |
| amount | Naira |
| status | `pending → withdrawable → withdrawn` |

### Withdrawal
Withdrawal request submitted by an affiliate.

| Field | Notes |
|---|---|
| user | userId |
| amount | Naira |
| bankName/bankCode/accountNumber/accountName | copied from user at request time |
| status | `pending → approved \| rejected` |
| reason | admin rejection note |

### Settings
Single-document collection; admin-editable platform config.

| Field | Default | Notes |
|---|---|---|
| paystackKey / paystackSecret | '' | live keys stored in DB |
| commissionLevel1–6 | 65/15/5/3/2/1 | % rates |
| subscriptionPrice | 5000 | Naira |
| trialDays | 7 | |
| minWithdrawal | 10000 | Naira |

### Notification
In-app notifications for both users and admins.

| Field | Notes |
|---|---|
| userId | recipient |
| userType | `student \| admin` |
| type | `admin_created \| course_added \| announcement \| system` |
| read | Boolean |

### ChatMessage
Support chat between a user and admins. One conversation per user.

| Field | Notes |
|---|---|
| conversationId | userId (the user side of the thread) |
| senderId | |
| senderType | `user \| admin` |
| senderName | |
| message | max 2000 chars |
| read | Boolean |

### ModuleUnlock
Records a paid individual module unlock (separate from stage-based access).

| Field | Notes |
|---|---|
| userId, courseId | ObjectId refs |
| moduleId | embedded module _id (string) |
| amount, reference | payment details |

Unique index on `(userId, moduleId)`.

### UsedReference
Idempotency guard. Created immediately before access is granted on any Paystack verify call. The `unique` index on `reference` prevents double-processing even under concurrent requests.

| Field | Notes |
|---|---|
| reference | Paystack transaction reference (unique) |
| userId | who paid |
| purpose | `subscription \| stage \| module` |
| amount | Naira |

---

## API Routes

Routes are mounted at **both** `/` and `/api` so the user frontend (calls `/user-auth/…`) and admin frontend (calls `/api/auth/…`) both work.

### User — Authentication (`/user-auth`)
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | — | Send OTP to email (pending registration stored in-memory Map) |
| POST | `/verify-email` | — | Confirm OTP → create User + issue JWT |
| POST | `/login` | — | Email/password → JWT |
| GET | `/me` | User JWT | Refresh user profile |
| POST | `/logout` | User JWT | Stateless (client discards token) |

### User — Student (`/student`)
All routes require User JWT.

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Earnings stats, referral count, recent courses |
| GET | `/courses` | Full course list with stage access gates |
| GET | `/commissions` | User's commission history |
| GET | `/withdrawals` | User's withdrawal history |
| POST | `/withdrawals` | Submit withdrawal request |
| GET/PATCH | `/bank-account` | Read/save bank account details |
| GET | `/referrals` | Referral code + direct referral list |
| GET | `/unlocked-modules` | Module unlock records for a course |
| PATCH | `/profile` | Update name/phone |
| POST | `/change-password` | Change password (requires current password) |

### User — Payments (`/payment`)
All routes require User JWT.

| Method | Path | Description |
|---|---|---|
| POST | `/init` | Initialise subscription payment → Paystack auth URL |
| GET | `/verify` | Verify subscription payment reference → activate subscription + distribute commissions |
| POST | `/init-module` | Initialise module unlock payment |
| GET | `/verify-module` | Verify module payment → create ModuleUnlock record |
| POST | `/init-stage` | Initialise stage upgrade payment (fish/shark/whale) |
| GET | `/verify-stage` | Verify stage payment → upgrade stage + distribute commissions |
| POST | `/verify-account` | Resolve bank account name via Paystack |
| POST | `/webhook` | Paystack HMAC-verified webhook (charge.success fallback) |

### User — Chat (`/chat`) & Notifications (`/student/notifications`)
| Method | Path | Description |
|---|---|---|
| GET | `/chat/messages` | Fetch conversation, mark admin messages read |
| POST | `/chat/send` | Send message to admin |
| GET | `/chat/unread-count` | Unread admin replies count |
| GET | `/student/notifications` | Latest 50 notifications |
| PUT | `/student/notifications/:id/read` | Mark one read |

### Admin — Authentication (`/auth`)
| Method | Path | Description |
|---|---|---|
| POST | `/login` | Email/password → JWT |
| GET | `/me` | Admin profile |
| POST | `/logout` | Stateless |
| POST | `/forgot-password` | Send OTP to admin email |
| POST | `/reset-password` | Verify OTP + set new password |

### Admin — Management Routes
All require Admin JWT (`admin` or `superadmin` role).

| Router | Key endpoints |
|---|---|
| `/users` | List, get, ban, unban users; view commissions+withdrawals per user |
| `/courses` | `GET /public` (no auth), CRUD courses, add/edit/delete videos per stage |
| `/commissions` | List all commissions |
| `/withdrawals` | List, approve, reject; marks commissions as `withdrawn` on approval |
| `/dashboard` | Aggregate stats: user counts, revenue, growth chart, pending withdrawals |
| `/analytics` | KPIs, monthly revenue/users, commission by level, top referrers |
| `/settings` | `GET /public` (no auth), get/update platform settings |
| `/announcements` | List, create, delete announcements |
| `/notifications` | List admin notifications, mark read |
| `/email-blast` | Send email to all users or filtered segment |
| `/admin-chat` | List conversations, read messages per user, reply, unread counts |
| `/admins` | List, create, update, delete admin accounts |
| `/upload` | Multer file upload (images/thumbnails) → served from `/uploads` |

---

## Commission System

Triggered by `distributeCommissions(subscriberId, amountNaira)` after every successful payment.

**Logic:**
1. Look up the subscriber's `referredBy` (referral code of their recruiter).
2. Walk up the chain up to 6 levels.
3. At each level, skip the affiliate if their subscription is not `active`.
4. Create a `Commission` record using the rate for that level.
5. At level 1 only, increment the affiliate's `referrals` counter.

**Rates (hardcoded, also stored in Settings for display):**

| Level | Rate |
|---|---|
| 1 | 65% |
| 2 | 15% |
| 3 | 5% |
| 4 | 3% |
| 5 | 2% |
| 6 | 1% |

---

## Payment Flow

```
User clicks Subscribe
        │
        ▼
POST /payment/init
  → Paystack /transaction/initialize
  ← authorizationUrl, reference
        │
        ▼
User completes payment on Paystack hosted page
        │
   ┌────┴────────────────────────────────────┐
   ▼ (callback redirect)                     ▼ (webhook, async)
GET /payment/verify?reference=…       POST /payment/webhook
  1. Check UsedReference (idempotency)
  2. Verify reference with Paystack
  3. Validate tx.amount ≥ expected
  4. Create UsedReference record
  5. Activate subscription (if not active)
  6. distributeCommissions()
  7. emit('payment:new', …)
```

Stages (fish/shark/whale) and module unlocks follow the same init → verify pattern.

---

## Real-time Events (Socket.IO)

Clients authenticate into rooms by sending a JWT on connect.

| Room | Who joins | Events emitted to it |
|---|---|---|
| `user_{userId}` | Each logged-in user | `chat:message`, `notification:new` |
| `admins` | All logged-in admins | `chat:message`, `notification:admin`, `withdrawal:updated`, `payment:new`, `user:registered` |

---

## Background Jobs (node-cron)

All jobs start when the server boots after MongoDB connects.

| Job | Schedule | What it does |
|---|---|---|
| `trialReminder` | 08:00 daily | Emails users whose trial ends in 1–3 days |
| `payoutReminder` | 08:00 on the 14th | Emails affiliates with a pending commission balance |
| `subscriptionExpiry` | 09:00 daily | Auto-expires lapsed `active` subscriptions; sends renewal warning emails at 7, 3, 2, 1 days before expiry |

---

## Authentication & Security

- **Two separate JWT guards**: `requireUserAuth` (roles: student, affiliate) and `requireAuth` (roles: admin, superadmin). Both read `Authorization: Bearer <token>`.
- **OTP registration**: account only created after email verification. OTP stored in-memory `Map` with 10-min TTL and 5-attempt limit.
- **Rate limiting**: 10 req/15 min on auth routes, 5 req/15 min on OTP routes.
- **Paystack webhook**: HMAC-SHA512 signature verified against raw request body before any processing.
- **Payment idempotency**: `UsedReference` collection with unique index on `reference` prevents a Paystack reference from activating a subscription or distributing commissions more than once.
- **Helmet**: sets secure HTTP headers including cross-origin resource policy.
- **CORS**: `CORS_ORIGIN` env var (comma-separated) in production; `*` in local dev.
- **JWT_SECRET**: minimum 32 characters enforced at startup; server exits if missing.

---

## Infrastructure & Deployment

```
Internet (HTTPS :443)
        │
        ▼
   Caddy 2 (TLS)          ← caddy:2-alpine, auto-HTTPS
        │
   ┌────┴──────────────────────────────┐
   ▼                   ▼              ▼
selebration-server  selebration-admin  selebration-user
(Express :5000)     (nginx :80)        (nginx :80)
       │
       ▼
  MongoDB Atlas
```

**Docker:**
- Multi-stage build: `BUILD` stage compiles TypeScript (`tsc`), runtime stage installs production deps only.
- Non-root user (`appuser`) in the runtime container.
- `uploads/` directory created and owned by `appuser`.

**CI/CD (`.github/workflows/deploy.yml`):**
1. On every push to `main` or `production`: run `npm ci && npm test`.
2. On push to `production` only (after tests pass): build Docker image and push to `ghcr.io/kingselo/selebration-server:latest`.
3. VPS must manually run `docker compose pull server && docker compose up -d server` to pick up the new image.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | Yes | MongoDB Atlas connection string |
| `JWT_SECRET` | Yes | Min 32 chars |
| `EMAIL_USER` | Yes | Gmail address for Nodemailer |
| `EMAIL_PASS` | Yes | Gmail app password |
| `CORS_ORIGIN` | Yes (prod) | Comma-separated allowed origins |
| `FRONTEND_URL` | Yes (prod) | User frontend base URL (for Paystack callback) |
| `PAYSTACK_SECRET_KEY` | Fallback | Used if not set in Settings collection |
| `PORT` | No | Defaults to 5000 |
| `SUBSCRIPTION_PRICE` | No | Fallback price used in dashboard stats |
