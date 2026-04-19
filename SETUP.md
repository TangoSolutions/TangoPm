# Aria — AI Leasing Assistant
### Setup & Deployment Guide

---

## What this system does
- Aria answers WhatsApp and voice enquiries from tenants 24/7
- Pre-qualifies tenants (income, deposit, move date, employment) before they reach the agent
- Scores each tenant (0-100) and routes only qualified leads to agents
- Auto-sends agent a summary WhatsApp when a qualified lead books a viewing
- Follows up with cold leads automatically after 24 hours
- Dashboard for agents to see all leads, scores, and viewings

---

## Step 1 — Prerequisites
- Node.js 18+
- A Railway account (railway.app)
- Your Twilio Account SID and Auth Token
- Your Anthropic API key

---

## Step 2 — Local setup

```bash
cd aria
npm install
cp .env.example .env
# Fill in your .env values
```

---

## Step 3 — Deploy to Railway

### Option A: Railway CLI (fastest)
```bash
npm install -g @railway/cli
railway login
railway init         # creates new project
railway add          # add PostgreSQL plugin
railway up           # deploy
railway open         # get your URL
```

### Option B: GitHub
1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add PostgreSQL plugin in Railway dashboard
4. Set environment variables (copy from .env.example)

---

## Step 4 — Environment variables (set in Railway)

| Variable | Where to get it |
|---|---|
| ANTHROPIC_API_KEY | console.anthropic.com |
| TWILIO_ACCOUNT_SID | console.twilio.com |
| TWILIO_AUTH_TOKEN | console.twilio.com |
| TWILIO_WHATSAPP_NUMBER | Twilio → Messaging → WhatsApp Senders |
| TWILIO_VOICE_NUMBER | Twilio → Phone Numbers |
| DATABASE_URL | Auto-set by Railway PostgreSQL plugin |
| DASHBOARD_SECRET | Any long random string |
| BASE_URL | Your Railway app URL |

---

## Step 5 — Run database migrations

```bash
# Locally with your DATABASE_URL set:
npm run db:migrate

# Then seed with demo data:
npm run db:seed
```

Or run via Railway:
```bash
railway run npm run db:migrate
railway run npm run db:seed
```

---

## Step 6 — Configure Twilio webhooks

In Twilio Console:

### WhatsApp (Sandbox or Business number)
- Go to: Messaging → Senders → WhatsApp → your number
- Webhook URL: `https://YOUR-APP.railway.app/whatsapp/inbound`
- Method: POST

### Voice
- Go to: Phone Numbers → your number → Voice Configuration
- When a call comes in: Webhook → `https://YOUR-APP.railway.app/voice/inbound`
- Method: POST

---

## Step 7 — Test Aria

Send a WhatsApp to your Twilio number:
> "Is the Sea Point apartment still available?"

Aria should respond within 2-3 seconds.

---

## Step 8 — Add your first real client (agent)

Use the API or dashboard:

```bash
curl -X POST https://YOUR-APP.railway.app/api/agents \
  -H "x-dashboard-key: YOUR_DASHBOARD_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Smith",
    "agency_name": "Cape Town Rentals",
    "email": "jane@agency.co.za",
    "whatsapp_number": "+27821234567",
    "notification_whatsapp": "+27821234567"
  }'
```

Then add their first property:

```bash
curl -X POST https://YOUR-APP.railway.app/api/properties \
  -H "x-dashboard-key: YOUR_DASHBOARD_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "2-Bed Apartment, Sea Point",
    "address": "14 Ocean View Drive, Sea Point",
    "suburb": "Sea Point",
    "monthly_rent": 18500,
    "deposit": 37000,
    "bedrooms": 2,
    "available_from": "2025-06-01",
    "agent_id": "AGENT_ID_FROM_ABOVE"
  }'
```

---

## Dashboard API endpoints

| Endpoint | Description |
|---|---|
| GET /api/stats | Overview: enquiries, qualified, booked |
| GET /api/leads/:id | Single lead detail with full conversation |
| GET /api/properties | All properties |
| POST /api/properties | Add property |
| GET /api/agents | All agents |
| POST /api/agents | Add agent |
| GET /api/viewings | All viewings |
| GET /api/revenue | Revenue tracker |

All require header: `x-dashboard-key: YOUR_DASHBOARD_SECRET`

---

## Qualification scoring

| Factor | Points |
|---|---|
| Income ≥ 3.5x rent | 40 |
| Income ≥ 3.0x rent | 30 |
| Income ≥ 2.5x rent | 15 |
| Deposit available | 30 |
| Move date within 30 days | 20 |
| Move date within 60 days | 10 |
| Employment confirmed | 10 |

- 70+ = Qualified ✅
- 45-69 = Borderline ⚠️
- Under 45 = Unqualified ❌

---

## Aria's conversation flow

```
Tenant enquiry
  ↓
Aria confirms availability
  ↓
Asks income (casually)
  ↓
Asks deposit readiness
  ↓
Asks move date
  ↓
Asks employment
  ↓
Scores tenant
  ↓
Qualified → offers viewing + notifies agent
Unqualified → kind decline
Borderline → proceeds but flags to agent
  ↓
Books viewing
  ↓
Agent receives summary via WhatsApp
```

---

## Monthly costs (at 20 clients)

| Cost | Amount |
|---|---|
| Railway Pro | ~R350/mo |
| PostgreSQL (Railway) | Included |
| Anthropic API | ~R150-500/mo |
| Twilio WhatsApp | ~R200/mo |
| Twilio Voice | ~R300/mo |
| **Total** | **~R1,000-1,350/mo** |

At R4% per booking on R12k avg rent = R480/booking.
Break even at 3 bookings/month. Everything after is profit.

---

## Your sales pitch (one line)

> "Our AI pre-qualifies tenants before viewings — your agents only meet serious applicants."

---

## Support
Built by: You + Aria
Questions: check the /health endpoint first, then logs in Railway dashboard.
