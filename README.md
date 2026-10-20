# AuraFX – forex simulator & education platform (demo)

A complete front-end build of the AuraFX specification: public website, customer account area, demo trading
terminal, wallet (sandbox payments), KYC workflow and an admin console with role-based access.

> **Read this first – what this is and is not**
> * Chosen business model: **A + DEMO** – education/analytics plus a clearly labelled *demo simulator*.
>   There is **no live execution, no real deposits and no real withdrawals**. Every screen says so.
> * It is a **static site** (HTML/CSS/vanilla JS, no build step). A browser-side module called the *simulated backend*
>   enforces the business rules so the whole product can be exercised on GitHub Pages. **Browser storage is not a
>   secure database.** Nothing here may be used with real customer data or real money until the backend in
>   `docs/ARCHITECTURE.md` is built.
> * Legal pages are **templates**, not legal advice. Company details in `js/config.js` are placeholders.

## Run it

```bash
python3 -m http.server 8000      # or: npx serve .
# open http://localhost:8000
node tests/backend.test.js        # 50+ rule checks for the simulated backend
```

First visit `#/admin/login`: there are **no default credentials** – the first-run screen creates the super administrator.
Email/SMS/MFA codes appear in the **Demo mailbox** (`#/mailbox`).

## Deploy to GitHub Pages

1. Create a repository and push this folder to `main`.
2. Settings → Pages → Source: **GitHub Actions**. The included workflow runs the tests then publishes.
3. Open `https://<user>.github.io/<repo>/`. Hash routing means no server rewrites are needed.

## What is included (mapped to the spec)

| Area | Where |
|---|---|
| Public site: home, products, markets, pricing, learn, help/FAQ search, about/contact, status, legal set, cookie notice | `js/public.js` |
| Register (validation, age/country, consent versions, honeypot, no account enumeration), verify email, login, MFA, reset, rate limits | `js/auth-views.js`, `js/api-auth.js` |
| Account states and capability rules (PENDING_EMAIL_VERIFICATION → … → APPROVED / RESTRICTED / SUSPENDED / CLOSED) | `Acct` in `js/api-auth.js` |
| Customer area: overview, markets, watchlist & alerts, charts, demo terminal, orders, wallet, deposit, withdraw, transactions, statements, verification, notifications, support, profile, security/sessions, preferences, legal/data export, account closure | `js/app-views*.js` |
| Double-entry ledger, sandbox provider, signed webhooks, idempotency, state machines, refunds, withdrawals with holds and dual approval, adjustments | `js/api-finance.js` |
| Admin: users (9-tab detail), KYC queue with dual review, payments, webhook events + safe reprocess, refunds, withdrawals, ledger, reconciliation, adjustments, tickets, content, integrations, roles/permission matrix, fees/limits/flags/maintenance, hash-chained audit log | `js/admin-views.js` |
| Roles: super admin, compliance, finance, support, content, auditor | `ROLE_PERMS` in `js/api-auth.js` |

## Making it real

See `docs/ARCHITECTURE.md` (what to replace), `docs/api.md` (endpoint + webhook contract), `docs/schema.sql`
(PostgreSQL schema) and `docs/launch-checklist.md` (legal/compliance/security gates). Do not accept real
money before every item in that checklist is complete.
