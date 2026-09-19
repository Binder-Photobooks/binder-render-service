// render-worker.js
//
// The actual rendering logic. Does NOT reimplement anything about how a Binder book gets laid
// out into a PDF — it fetches the order's data with full (service-role) access to Supabase,
// launches a real headless Chrome tab, opens the live Binder site in it, and calls the exact
// same JS function (`window.renderOrderHeadless`) the site's own "Render" button in Admin →
// PDF Manager already uses. The heavy lifting — page layout, image placement, DPI math, fonts —
// all happens inside that one shared function on the site itself. This file's job is just:
// fetch → drive a browser → collect the finished file → upload it → record what happened.

const fs = require('fs');
const path = require('path');
const os = require('os');
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
  // A dedicated, unique temp folder per render — Chrome's download mechanism needs somewhere
  // real on disk to write the finished file to; cleaned up in the `finally` block below either
  // way, success or failure.
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-render-'));

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

    // 3. Point downloads at our temp folder, using Chrome DevTools Protocol directly — this
    //    is how the finished PDF actually gets out of the browser. The earlier version of
    //    this file had window.renderOrderHeadless() RETURN the PDF as a base64 string through
    //    page.evaluate(), but that channel has a hard ~100MB limit (confirmed against
    //    Puppeteer's own issue tracker) — a full-resolution, many-page, high-photo-count book
    //    blows past that easily and silently fails, which is exactly what was producing blank
    //    PDFs for real orders while small test ones worked fine. A real browser download has
    //    no such size ceiling. Uses a BROWSER-level CDP session with Browser.setDownloadBehavior
    //    / Browser.downloadProgress specifically — the page-level Page.setDownloadBehavior /
    //    Page.downloadProgress equivalents are marked deprecated in Chrome's own DevTools
    //    Protocol documentation in favour of these.
    const client = await browser.target().createCDPSession();
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true, // required for downloadProgress events to actually fire
    });

    // Resolves once Chrome reports the download as fully written to disk — driven by the
    // browser's own event, not by polling the filesystem and guessing when a file has
    // finished growing.
    const downloadComplete = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Download did not complete within 3 minutes — possibly a very large book, or the render itself hung')), 180000);
      client.on('Browser.downloadProgress', (event) => {
        if (event.state === 'completed') { clearTimeout(timeout); resolve(); }
        else if (event.state === 'canceled') { clearTimeout(timeout); reject(new Error('Download was canceled by the browser')); }
      });
    });

    // 4. Load the live site and wait for it to finish initializing — specifically, for the
    //    headless entry point the site exposes on window to actually exist.
    await page.goto(SITE_URL, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction('typeof window.renderOrderHeadless === "function"', { timeout: 30000 });

    // 5. Call the site's own rendering function directly, passing the already-fetched order in
    //    as a plain JS argument — the page itself never needs to query Supabase or hold any
    //    credentials at all. It triggers a real download rather than returning the PDF data;
    //    this call's own return value is now just a small, safe {ok, error?} status.
    const result = await page.evaluate(
      (orderData, key) => window.renderOrderHeadless(orderData, key),
      order,
      fileKey
    );

    if (!result || !result.ok) {
      throw new Error(`In-browser render failed: ${(result && result.error) || 'unknown error'}`);
    }

    // 6. Wait for the download itself to finish, then read the actual file bytes off disk —
    //    Chrome may save it under an internal download GUID rather than the suggested
    //    filename depending on version, so read whatever landed in the folder rather than
    //    assuming an exact name.
    await downloadComplete;
    const filesInDir = fs.readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload'));
    if (!filesInDir.length) throw new Error('Download reported complete, but no file was found in the download folder');
    const pdfBuffer = fs.readFileSync(path.join(downloadDir, filesInDir[0]));
    console.log(`[render] downloaded ${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB for ${orderId}/${fileKey}`);

    // 7. Upload those bytes straight to Storage.
    const storagePath = `${orderId}/${fileKey}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from(PDF_BUCKET)
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

    const { data: urlData } = supabase.storage.from(PDF_BUCKET).getPublicUrl(storagePath);

    // 8. Record the result on the order itself, same shape the site's own admin panel expects.
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
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

module.exports = { renderOrder };
