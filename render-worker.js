// render-worker.js
//
// The actual rendering logic. Does NOT reimplement anything about how a Binder book gets laid
// out into a PDF — it fetches the order's data with full (service-role) access to Supabase,
// launches a real headless Chrome tab, opens the live Binder site in it, and calls the exact
// same JS function (`window.renderOrderHeadless`) the site's own "Render" button in Admin →
// PDF Manager already uses. The heavy lifting — page layout, image placement, DPI math, fonts —
// all happens inside that one shared function on the site itself. This file's job is just:
// fetch → drive a browser → collect the result → upload it → record what happened.

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const SITE_URL = process.env.SITE_URL || 'https://www.binder.co.in/';
const PDF_BUCKET = process.env.PDF_BUCKET || 'rendered-pdfs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role — bypasses RLS by design, since this
  // runs server-side only and is never exposed to a browser. Keep this key out of any client
  // code or public repo; it grants full read/write access to your whole database.
);

/**
 * Renders one file (a cover set, or the interior pages) for one order, uploads the finished
 * PDF to Supabase Storage, and updates the order record. Throws on failure — the caller (see
 * server.js) is responsible for deciding what to do with that (log it, retry it, alert on it).
 */
async function renderOrder(orderId, fileKey) {
  console.log(`[render] starting ${orderId} / ${fileKey}`);

  // 1. Fetch the order directly — service role key means this always sees the real, current
  //    record regardless of any RLS policy, and needs no user session or auth token of its own.
  const { data: order, error: fetchErr } = await supabase
    .from('orders').select('*').eq('id', orderId).single();
  if (fetchErr || !order) throw new Error(`Order not found: ${orderId} (${fetchErr?.message || 'no matching row'})`);
  if (!order.snapshot) throw new Error(`Order ${orderId} has no saved design data (snapshot is empty)`);

  await supabase.from('orders').update({ render_status: 'rendering', render_error: null }).eq('id', orderId);

  let browser;
  try {
    // 2. Launch headless Chrome. --no-sandbox is required on almost every container host
    //    (Render, Railway, Fly.io, Docker generally) since the sandbox needs kernel privileges
    //    those environments don't grant — this is standard, expected Puppeteer-in-a-container
    //    configuration, not a security downgrade specific to this project.
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // containers often have a tiny /dev/shm; this avoids Chrome crashing from it
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1024 });

    // Surface in-page console errors and crashes in this service's own logs — without this,
    // a JS error inside the site's rendering code would just show up as a generic timeout here,
    // with no clue what actually went wrong.
    page.on('pageerror', (err) => console.error(`[render] page error for ${orderId}:`, err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') console.error(`[render] console.error:`, msg.text()); });

    // 3. Load the live site and wait for it to finish initializing — specifically, for the
    //    headless entry point the site exposes on window to actually exist.
    await page.goto(SITE_URL, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction('typeof window.renderOrderHeadless === "function"', { timeout: 30000 });

    // 4. Call the site's own rendering function directly, passing the already-fetched order in
    //    as a plain JS argument — the page itself never needs to query Supabase or hold any
    //    credentials at all.
    const result = await page.evaluate(
      (orderData, key) => window.renderOrderHeadless(orderData, key),
      order,
      fileKey
    );

    if (!result || !result.ok) {
      throw new Error(`In-browser render failed: ${(result && result.error) || 'unknown error'}`);
    }

    // 5. Decode the returned PDF (a data URI) and upload it to Storage.
    const base64 = result.dataUri.split(',')[1];
    const pdfBuffer = Buffer.from(base64, 'base64');
    const storagePath = `${orderId}/${fileKey}.pdf`;

    const { error: uploadErr } = await supabase.storage
      .from(PDF_BUCKET)
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

    const { data: urlData } = supabase.storage.from(PDF_BUCKET).getPublicUrl(storagePath);

    // 6. Record the result on the order itself, same shape the site's own admin panel expects.
    const pdfFiles = { ...(order.pdf_files || {}), [fileKey]: urlData.publicUrl };
    await supabase.from('orders').update({
      pdf_files: pdfFiles,
      render_status: 'ready',
      render_error: null,
      pdf_version: (order.pdf_version || 0) + 1,
    }).eq('id', orderId);

    console.log(`[render] done ${orderId} / ${fileKey} → ${urlData.publicUrl}`);
    return { ok: true, url: urlData.publicUrl };
  } catch (err) {
    const message = (err && err.message) || String(err);
    console.error(`[render] FAILED ${orderId} / ${fileKey}:`, message);
    await supabase.from('orders').update({ render_status: 'failed', render_error: message }).eq('id', orderId);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { renderOrder };
