# Deploying to Railway.app instead of Render

Same service, different host. Everything about the code is identical — this is just an
alternative set of deployment steps if you'd rather use Railway than Render.

## Steps

1. **Create a Railway account** at [railway.app](https://railway.app) — GitHub sign-in is the
   easiest option, and it'll be the same GitHub account that already has your
   `binder-render-service` repo.

2. **New Project** → **Deploy from GitHub repo** → select `binder-render-service`.

3. Railway auto-detects this as a Node.js project (via `package.json`) and will build and start
   it automatically — you shouldn't need to type in a build or start command manually, though
   the included `railway.json` gives it explicit instructions either way.

4. **Add environment variables.** Click into the deployed service → **Variables** tab → add:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase → Project Settings → API → service_role
   - `RENDER_SECRET` — make up a long random password (the name is just historical from when
     this was Render-only; it works exactly the same way regardless of which platform runs it)
   - `SITE_URL` — `https://www.binder.co.in/`
   - `PDF_BUCKET` — `rendered-pdfs`

5. Railway will redeploy automatically once you save the variables. Watch the **Deployments**
   tab for it to go green/"Success".

6. **Get the service's public URL.** Railway doesn't always expose a public URL by default —
   look for **Settings** → **Networking** → **Generate Domain** if you don't see one already.
   Copy that URL.

7. Back on the Binder site: **Admin → Content**, paste that URL into **Render Service URL**, and
   your `RENDER_SECRET` value into **Render Service Secret**. Save.

8. Test it: **Admin → PDF Manager** → pick an order → click **Render (server)**.

## A note on card verification

Railway's policies around requiring a card for free-tier usage change over time and may or may
not differ from Render's — I can't guarantee this sidesteps that requirement. If it asks for one
too, the same applies as before: it's a standard anti-abuse measure for any platform that lets
you run real backend compute, not something specific to this project.
