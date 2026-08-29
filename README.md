# Gather — Family Meal Planner (Netlify version)

This is the same planner, restructured so it works as a real deployed
site instead of a Claude artifact. Everything (family profiles, recipes,
this week's plan, the usual template, grocery checkboxes) is stored in
one JSON object in **Netlify Blobs** — Netlify's built-in data store, so
there's no separate database to sign up for or pay for.

It also sends three automated reminder emails via **Resend**:

| Reminder | When (Johannesburg time) | What it says |
|---|---|---|
| Plan the week | Fridays, 5pm | A nudge to sit down and plan next week, with a link to the app |
| Grocery day | Sundays, 9am | This week's actual grocery list, pulled live from the app |
| Tonight's dinner | Daily, 3pm (weekdays only) | What each person's having tonight |

```
gather-netlify/
├─ index.html                          the app (unchanged UI/logic)
├─ netlify/functions/state.mts         reads/writes the data via Netlify Blobs
├─ netlify/functions/reminder-plan-week.mts
├─ netlify/functions/reminder-grocery-day.mts
├─ netlify/functions/reminder-dinner-tonight.mts
├─ netlify/functions/utils/email.mts   shared Resend sender (not its own function)
├─ netlify.toml
├─ package.json
└─ .gitignore
```

## Why a folder, not just the HTML file

Blobs and scheduled functions need a real deploy (git or the CLI) — a
plain drag-and-drop of a single HTML file onto Netlify won't include
them. Two ways to deploy:

### Option A — Git (recommended, matches how you'd maintain it going forward)

1. Push this folder to a new GitHub/GitLab repo.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
3. Build settings: leave the build command empty, publish directory `.`
   (already set in `netlify.toml`, so Netlify should pick this up automatically).
4. Deploy. Netlify installs the dependencies in `package.json` and wires
   up the functions automatically — no extra configuration needed for Blobs.

### Option B — Netlify CLI, from this folder

```bash
npm install
npx netlify-cli deploy --prod
```

Follow the prompts to link or create a site.

## Setting up email — required before reminders will send

1. **Sign up at [resend.com](https://resend.com)** (free tier covers this
   easily) and grab an API key.
2. In Netlify: **Site configuration → Environment variables**, add:
   - `RESEND_API_KEY` — the key from Resend.
   - `REMINDER_EMAILS` — who receives them, comma-separated
     (e.g. `clinton@example.com,tina@example.com`).
   - `REMINDER_FROM` — optional. Until you verify your own domain in
     Resend, leave this unset and it'll send from Resend's shared
     `onboarding@resend.dev` address, which works immediately but looks
     less polished. Once you verify a domain (Resend walks you through
     adding a couple of DNS records), set this to something like
     `Gather <reminders@yourdomain.com>`.
   - `APP_URL` — optional, e.g. `https://your-site.netlify.app`. Adds a
     direct link into the Friday planning email.
3. Redeploy (or trigger **Clear cache and deploy**) so the functions
   pick up the new environment variables.

**Scheduled functions only run on the live production deploy**, not on
deploy previews — so you won't see them fire until this is actually
published.

## Changing the timing

Each reminder function has an `export const config = { schedule: "..." }`
line — that's a standard cron expression, evaluated in UTC. Johannesburg
is UTC+2 year-round (no daylight saving), so subtract 2 hours from the
time you want to get the UTC value. For example, 5pm SAST → `17 - 2 = 15`,
so `"0 15 * * 5"` (Friday). Edit the value, redeploy, done.

## Local development

```bash
npm install
npx netlify-cli dev
```

This runs the site and all the functions together at `localhost:8888`,
with a sandboxed local Blobs store. Scheduled functions don't fire on
their cron in local dev — trigger one manually to test it:

```bash
npx netlify-cli functions:invoke reminder-grocery-day
```

## One thing worth deciding: access

There's no login on this right now — anyone with the site's URL can view
and edit everything, family or otherwise. Fine for a private link only
you and Tina have, but if you'd rather lock it down, the simplest option
is Netlify's built-in site password (Team/Pro plans, under **Site
configuration → Visitor access**). Say the word if you want that wired
in more thoroughly (e.g. a real login) instead.

## If something looks out of date

Netlify's and Resend's APIs move fast. If `npm install` complains, or a
function errors on deploy, that's usually a version mismatch — bump the
versions in `package.json` and try again.
