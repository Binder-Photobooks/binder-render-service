# Binder Render Service

A small, separate backend service that renders order PDFs on a server instead of in an admin's
browser tab. It works by driving a real headless Chrome browser to the live binder.co.in site
and calling the exact same rendering function the "Render" button in Admin → PDF Manager
already uses — so there's only one piece of code that actually knows how to lay out a book into
a PDF, and it's the one that's already tested and working.

**This is a separate deployment from the main site.** It does not go on Vercel, and it is not
part of the `binder-deploy-updated.zip` you've been uploading there. It's its own small
always-on service, hosted somewhere that can run a real Chrome instance (Vercel's serverless
functions can't).

---

## What you'll need before starting

- A Supabase project (you already have this — same one the main site uses)
- 10–15 minutes
- A card for the hosting platform's paid tier (see below — the free tier doesn't have enough
  memory for headless Chrome to run reliably)

---

## Step 1 — Create a Storage bucket for rendered PDFs

1. Open your Supabase project dashboard → **Storage**
2. Click **New bucket**
3. Name it exactly `rendered-pdfs`
4. Toggle it **Public** (so the uploaded PDF links can actually be opened/downloaded)
5. Save

This is separate from your existing `cms-images` and `photos` buckets — keeping rendered PDFs in
their own bucket makes them easy to find and manage.

## Step 2 — Get your Supabase service role key

1. Supabase dashboard → **Project Settings** → **API**
2. Under "Project API keys", find **service_role** and click **Reveal**
3. Copy it somewhere safe for a moment — you'll paste it into your hosting platform in Step 4

⚠️ **This key bypasses all your database security rules.** Never put it in the website's code,
never commit it to a public repo, never share it. It only ever goes into this separate service's
private environment variables.

## Step 3 — Choose where to host this service

I'd recommend **[Render.com](https://render.com)** — it's what the included `render.yaml` is
set up for, and it's one of the simplest places to run a small always-on Node service with
headless Chrome support. (Railway or Fly.io would also work if you prefer either of those —
the code itself doesn't care, only the deployment steps would differ slightly.)

1. Create a Render.com account (github/google sign-in is fine)
2. Push this `render-service` folder to its own GitHub repository (a new, separate repo from
   your main site — e.g. `binder-render-service`)
3. In Render: **New** → **Blueprint** → connect that repo. Render will read `render.yaml` and
   set up the service automatically
4. It'll ask you to choose a plan — pick **Starter** (a few dollars/month). The free tier's
   memory limit is too small for Chrome to run without crashing.

## Step 4 — Set the environment variables

In Render, open your new service → **Environment**, and add:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL (Project Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | The key you copied in Step 2 |
| `RENDER_SECRET` | Make up a long random password — this is what the Admin panel uses to prove it's allowed to trigger renders |

To generate a good `RENDER_SECRET`, run this on your own computer (Node needs to be installed):
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the output — that's your secret. Use the same one in Step 5 below.

`SITE_URL` and `PDF_BUCKET` are already set correctly by `render.yaml` — no need to touch those
unless you want to point this at a staging site instead.

## Step 5 — Connect the Admin panel to this service

Once Render shows your service as **Live**, copy its URL (something like
`https://binder-render-service.onrender.com`).

1. On the main Binder site: **Admin → Content**, find the two new fields near the bottom:
   **Render Service URL** and **Render Service Secret**
2. Paste the Render URL into the first, and the same `RENDER_SECRET` value from Step 4 into the
   second
3. Save

Admin → PDF Manager will now show a **"Render (server)"** button next to the existing "Render"
button on every order. The original button still works exactly as before — this is purely
additive, so if anything about the new service isn't working yet, rendering isn't blocked.

## Step 6 — Test it

1. Go to **Admin → PDF Manager**, pick any order with saved design data
2. Click **Render (server)**
3. Within a few seconds to a couple of minutes (depending on book length), the order's status
   should update to "ready" and a download link should appear — pulled from Supabase, the same
   way the existing render results already display

If it doesn't work, check the Render dashboard's **Logs** tab for that service — every step of
the render (fetching the order, launching Chrome, calling the site, uploading the PDF) logs a
line, so the logs should point straight at whichever step failed.

---

## Optional — fully automatic rendering

Instead of clicking "Render (server)" manually, you can have every order render itself the
moment it's placed:

1. Supabase dashboard → **Database** → **Webhooks** → **Create a new webhook**
2. Table: `orders`, Events: `Update`
3. URL: `https://your-render-service-url.onrender.com/render-webhook`
4. HTTP Headers: add `Authorization` = `Bearer your-render-secret`
5. Save

Now, whenever an order's `render_status` becomes `pending` (which already happens automatically
today when an order is placed), Supabase itself calls this service, no one needs to click
anything.

---

## Endpoints this service exposes

- `GET /health` — returns `{ok: true}` if the service is alive; useful for checking it's up
- `POST /render` — body `{orderId, fileKey}`, header `Authorization: Bearer <RENDER_SECRET>` —
  triggers a render, responds immediately, does the work in the background
- `POST /render-webhook` — same auth, accepts a Supabase Database Webhook payload directly

## Local testing (optional, before deploying)

```
cd render-service
npm install
cp .env.example .env
# fill in .env with your real values
npm start
```
Then in another terminal:
```
curl -X POST http://localhost:3000/render \
  -H "Authorization: Bearer your-render-secret" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"BDR-3001","fileKey":"pages"}'
```
