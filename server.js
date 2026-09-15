// server.js
//
// A small HTTP wrapper around render-worker.js. Two ways to trigger a render:
//   1. Manually — Admin → PDF Manager's "Render (server)" button POSTs here directly.
//   2. Automatically — a Supabase Database Webhook can call /render-webhook whenever an
//      order's render_status changes to 'pending', so rendering happens on its own the moment
//      an order is placed, with no one needing to click anything.
// Both paths end up calling the exact same renderOrder() function.

require('dotenv').config();
const express = require('express');
const { renderOrder } = require('./render-worker');

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RENDER_SECRET'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Set these in your hosting platform\'s dashboard before starting this service — see README.md.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

function checkAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.RENDER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'binder-render-service', time: new Date().toISOString() });
});

// Manual trigger — called by Admin → PDF Manager's "Render (server)" button.
app.post('/render', checkAuth, (req, res) => {
  const { orderId, fileKey } = req.body || {};
  if (!orderId || !fileKey) {
    return res.status(400).json({ error: 'orderId and fileKey are required' });
  }

  // Respond immediately rather than holding the connection open — rendering a large book can
  // take anywhere from several seconds to a couple of minutes, and neither the admin panel nor
  // a webhook caller should have to wait synchronously for that. The admin panel instead polls
  // the order's render_status (already how it works today) to see when it's actually done.
  res.status(202).json({ ok: true, message: 'Render started', orderId, fileKey });

  renderOrder(orderId, fileKey).catch((err) => {
    console.error(`Unhandled render failure for ${orderId}/${fileKey}:`, err.message);
  });
});

// Optional automatic trigger — point a Supabase Database Webhook (Database → Webhooks in your
// Supabase dashboard) at this endpoint, firing on UPDATE to the orders table when render_status
// becomes 'pending'. Supabase webhooks send the row as `record` in the body.
app.post('/render-webhook', checkAuth, (req, res) => {
  const record = req.body?.record;
  if (!record || !record.id) {
    return res.status(400).json({ error: 'Expected a Supabase webhook payload with record.id' });
  }
  if (record.render_status !== 'pending') {
    return res.status(200).json({ ok: true, skipped: true, reason: 'render_status is not pending' });
  }

  res.status(202).json({ ok: true, message: 'Render started from webhook', orderId: record.id });

  // A webhook doesn't know which specific file (cover vs. interior) to render, since that
  // concept lives only in this project's own PDF Manager UI — render both by default. Adjust
  // this list if your product line-up needs different file keys.
  const filesToRender = ['cover', 'pages'];
  filesToRender.forEach((fileKey) => {
    renderOrder(record.id, fileKey).catch((err) => {
      console.error(`Unhandled webhook render failure for ${record.id}/${fileKey}:`, err.message);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binder render service listening on port ${PORT}`);
  console.log(`Site URL: ${process.env.SITE_URL || 'https://www.binder.co.in/'}`);
});
