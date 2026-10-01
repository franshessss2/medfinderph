// js/reserve.js — reservation page. requireAuth() gated: signed-out
// visitors never see this form.
//
// Reservation creation goes through exactly one write path: the
// reserve_stock() RPC (supabase/migration-002-defense.sql). It locks the
// stock row, enforces the active-reservation cap and holds units in one
// transaction. There is no client-side check-then-insert.
import { db, requireAuth } from './supabase-client.js';
import {
  escapeHtml, formatPeso, statusPillHtml, freshnessHtml, rxTagHtml,
  validateProofFile, proofExtension, rpcErrorCode, rpcErrorText,
  skeletonHtml, errorStateHtml, DISCLAIMER_TEXT,
} from './utils.js';
import { onReconnect } from './connection.js';

// Edit these once there's a real GCash account to receive payments —
// same "placeholder, wire up before launch" pattern as SUPABASE_URL in
// js/supabase-client.js.
const GCASH_ACCOUNT_NUMBER = '09XX XXX XXXX';
const GCASH_ACCOUNT_NAME = 'MedFinder PH (placeholder — set the real account)';

const MAX_QTY_PER_RESERVATION = 10; // mirrors c_max_qty in reserve_stock()

const content = document.getElementById('reserve-content');
const logoutBtn = document.getElementById('logout-btn');

let params = { medicineId: null, pharmacyId: null };
let currentSession = null;

logoutBtn?.addEventListener('click', async () => {
  try {
    await db.auth.signOut();
  } catch (err) {
    console.error('signOut threw:', err);
  }
  window.location.href = 'index.html';
});

function renderNotFound() {
  content.innerHTML = `
    <div class="card unavailable-card">
      <h2>We couldn't find that listing</h2>
      <p>The link may be out of date. Try searching again.</p>
      <a class="btn btn-primary" href="search.html">Back to search</a>
    </div>
  `;
}

function renderUnavailable(listing) {
  content.innerHTML = `
    <div class="card unavailable-card">
      <h2>${escapeHtml(listing.medicines.name)} is currently unavailable</h2>
      <p>${escapeHtml(listing.pharmacies.name)} has this marked out of stock right now.</p>
      <a class="btn btn-primary" href="search.html">Find another pharmacy</a>
    </div>
  `;
}

function renderError() {
  content.innerHTML = errorStateHtml(
    'Something went wrong',
    navigator.onLine ? 'Try again in a moment.' : 'You are offline. This page reloads when the connection returns.'
  );
  content.querySelector('[data-retry]')?.addEventListener('click', load);
}

/**
 * One pharmacy_stock query with nested selects — price, quantity, stock
 * status, freshness, prescription flag, medicine and pharmacy names in a
 * single round trip. maybeSingle() because a stale or hand-edited URL
 * resolving to zero rows is an expected user error, not a server error.
 */
async function fetchListing(medicineId, pharmacyId) {
  const { data, error } = await db
    .from('pharmacy_stock')
    .select('price, quantity, stock_status, updated_at, medicines ( id, name, generic_name, requires_prescription ), pharmacies ( id, name, location )')
    .eq('medicine_id', medicineId)
    .eq('pharmacy_id', pharmacyId)
    .maybeSingle();

  if (error) {
    console.error('fetchListing failed:', error.message);
    throw error;
  }
  return data;
}

function summaryMetaHtml(listing) {
  return `
    <div class="summary-price">${formatPeso(listing.price)}</div>
    ${statusPillHtml(listing.stock_status)}
    <p class="result-flags">${freshnessHtml(listing.updated_at)}</p>
  `;
}

function maxQty(listing) {
  return Math.max(1, Math.min(MAX_QTY_PER_RESERVATION, listing.quantity));
}

function renderForm(listing, session) {
  const rx = Boolean(listing.medicines.requires_prescription);

  content.innerHTML = `
    <div class="card summary-card">
      <div class="summary-main">
        <h2>${escapeHtml(listing.medicines.name)}</h2>
        <p class="summary-sub">${escapeHtml(listing.pharmacies.name)}${listing.pharmacies.location ? ' · ' + escapeHtml(listing.pharmacies.location) : ''}</p>
        ${rx ? `<p class="result-flags">${rxTagHtml(true)}</p>` : ''}
      </div>
      <div class="summary-meta" id="summary-meta">${summaryMetaHtml(listing)}</div>
    </div>

    <div class="card form-card">
      <h1>Reservation details</h1>

      <p class="form-alert form-alert-error" id="form-error" role="alert" hidden></p>

      <form id="reserve-form" novalidate data-requires-network>
        <div class="field-row">
          <div class="field">
            <label for="contact_name">Contact name</label>
            <input type="text" id="contact_name" name="contact_name" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="contact_phone">Contact phone</label>
            <input type="tel" id="contact_phone" name="contact_phone" autocomplete="tel" placeholder="09XX XXX XXXX" required />
          </div>
        </div>

        <div class="field">
          <label for="quantity">Quantity</label>
          <input type="number" id="quantity" name="quantity" min="1" max="${maxQty(listing)}" step="1" value="1" required />
          <span class="field-hint" id="quantity-hint">Up to ${maxQty(listing)} per reservation.</span>
        </div>

        <div class="field">
          <label for="notes">Notes (optional)</label>
          <textarea id="notes" name="notes" rows="3" placeholder="e.g. brand preference, preferred pickup time"></textarea>
        </div>

        ${rx ? `
        <label class="consent-row" for="rx_ack">
          <input type="checkbox" id="rx_ack" name="rx_ack" />
          <span>I understand I must present a valid prescription at pickup.</span>
        </label>` : ''}

        <p class="disclaimer-box">${escapeHtml(DISCLAIMER_TEXT)}</p>

        <div class="gcash-box">
          <p><strong>Pay via GCash</strong></p>
          <p>Send <span class="gcash-total" id="gcash-total">${formatPeso(listing.price)}</span> to
            <strong>${escapeHtml(GCASH_ACCOUNT_NUMBER)}</strong> (${escapeHtml(GCASH_ACCOUNT_NAME)}),
            then upload your screenshot below as proof.</p>
        </div>

        <div class="field">
          <label for="payment_proof">GCash payment screenshot</label>
          <label class="file-drop" for="payment_proof" id="file-drop-zone">
            <input type="file" id="payment_proof" name="payment_proof" accept="image/jpeg,image/png,image/webp" required />
            <span class="file-drop-label">Tap to choose a JPG, PNG or WebP image (max 5 MB)</span>
            <div class="file-drop-filename" id="file-drop-filename"></div>
          </label>
        </div>

        <button type="submit" class="btn btn-primary btn-block" id="submit-btn">Confirm reservation</button>
      </form>
    </div>
  `;

  wireForm(listing, session);
}

function wireForm(initialListing, session) {
  let listing = initialListing;
  const rx = Boolean(listing.medicines.requires_prescription);

  const form = document.getElementById('reserve-form');
  const errorEl = document.getElementById('form-error');
  const submitBtn = document.getElementById('submit-btn');
  const quantityInput = document.getElementById('quantity');
  const quantityHint = document.getElementById('quantity-hint');
  const totalEl = document.getElementById('gcash-total');
  const fileInput = document.getElementById('payment_proof');
  const fileNameEl = document.getElementById('file-drop-filename');
  const rxAck = document.getElementById('rx_ack');
  const summaryMeta = document.getElementById('summary-meta');

  // One in-flight request per page instance. The disabled button is UX;
  // this flag is the guard (a double Enter keypress or a programmatic
  // submit never reaches the network twice).
  let inFlight = false;

  function currentQty() {
    return Math.max(1, Math.min(maxQty(listing), parseInt(quantityInput.value, 10) || 1));
  }

  quantityInput.addEventListener('input', () => {
    totalEl.textContent = formatPeso(listing.price * currentQty());
  });

  const dropZone = document.getElementById('file-drop-zone');
  let dragCounter = 0;

  function updateFileDisplay() {
    const file = fileInput.files[0];
    fileNameEl.textContent = file ? file.name : '';
    dropZone.classList.toggle('has-file', Boolean(file));
  }

  fileInput.addEventListener('change', updateFileDisplay);

  // dragenter/dragleave counter, not a single flag: the drop zone has
  // child elements (label text, filename div), and the browser fires
  // dragleave every time the pointer crosses into one of those before
  // dragenter fires again on re-entry — a flag alone flickers the
  // highlight on and off as the pointer moves across children.
  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragCounter++;
    dropZone.classList.add('is-dragover');
  });

  dropZone.addEventListener('dragover', (event) => {
    // Must preventDefault on dragover too, every time — not just on
    // dragenter — or the browser never fires 'drop' at all.
    event.preventDefault();
  });

  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dropZone.classList.remove('is-dragover');
  });

  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('is-dragover');
    const dropped = event.dataTransfer.files;
    if (dropped.length > 0) {
      fileInput.files = dropped;
      updateFileDisplay();
    }
  });

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }
  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle('is-loading', isLoading);
    submitBtn.textContent = isLoading ? 'Submitting…' : 'Confirm reservation';
  }

  /** After INSUFFICIENT_STOCK: re-read the row so the page shows truth. */
  async function refreshStock() {
    try {
      const fresh = await fetchListing(params.medicineId, params.pharmacyId);
      if (!fresh) return;
      listing = { ...listing, ...fresh, medicines: fresh.medicines, pharmacies: fresh.pharmacies };
      summaryMeta.innerHTML = summaryMetaHtml(listing);
      quantityInput.max = String(maxQty(listing));
      quantityHint.textContent = listing.quantity < 1
        ? 'This listing is now out of stock.'
        : `Up to ${maxQty(listing)} per reservation.`;
      quantityInput.value = String(currentQty());
      totalEl.textContent = formatPeso(listing.price * currentQty());
    } catch (err) {
      console.error('refreshStock failed:', err);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (inFlight) return;
    clearError();

    const contact_name = form.contact_name.value.trim();
    const contact_phone = form.contact_phone.value.trim();
    const notes = form.notes.value.trim();
    const quantity = currentQty();
    const file = fileInput.files[0];

    if (!contact_name || !contact_phone) {
      showError('Fill in your contact name and phone number.');
      return;
    }
    if (rx && !rxAck.checked) {
      showError('Confirm that you will present a valid prescription at pickup.');
      return;
    }
    const fileError = validateProofFile(file);
    if (fileError) {
      showError(fileError);
      return;
    }

    inFlight = true;
    setLoading(true);
    let uploadedPath = null;
    let succeeded = false;

    try {
      // Path convention {user_id}/{uuid}.{ext} matches the storage RLS
      // policies in supabase/schema.sql (first path segment scopes access).
      // Extension derives from the validated MIME type, not the filename.
      const path = `${session.user.id}/${crypto.randomUUID()}.${proofExtension(file.type)}`;

      const { error: uploadError } = await db.storage
        .from('payment-proofs')
        .upload(path, file, { upsert: false, contentType: file.type });

      if (uploadError) {
        console.error('payment proof upload failed:', uploadError.message);
        showError('Could not upload your screenshot. Try again.');
        return;
      }
      uploadedPath = path;

      const { error: rpcError } = await db.rpc('reserve_stock', {
        p_pharmacy_id: listing.pharmacies.id,
        p_medicine_id: listing.medicines.id,
        p_quantity: quantity,
        p_payment_proof_path: path,
        p_contact_name: contact_name,
        p_contact_phone: contact_phone,
        p_notes: notes || null,
      });

      if (rpcError) {
        console.error('reserve_stock failed:', rpcError.message);
        const code = rpcErrorCode(rpcError);

        // The reservation was rejected, so the proof is an orphan. The
        // delete policy only permits removing unreferenced proofs.
        db.storage.from('payment-proofs').remove([uploadedPath]).catch(() => {});
        uploadedPath = null;

        if (code === 'NOT_AUTHENTICATED') {
          window.location.href = 'login.html';
          return;
        }
        showError(rpcErrorText(rpcError));
        if (code === 'INSUFFICIENT_STOCK' || code === 'LISTING_NOT_FOUND') await refreshStock();
        return;
      }

      succeeded = true;
      window.location.href = 'dashboard.html?reserved=1';
    } catch (err) {
      console.error('reservation submit threw:', err);
      showError('Something went wrong. Check your connection and try again.');
    } finally {
      // Success keeps the form locked while the browser navigates away;
      // every other exit re-arms it.
      if (!succeeded) {
        inFlight = false;
        setLoading(false);
      }
    }
  });
}

async function load() {
  content.innerHTML = skeletonHtml(2);
  try {
    const listing = await fetchListing(params.medicineId, params.pharmacyId);
    if (!listing || !listing.medicines || !listing.pharmacies) {
      renderNotFound();
      return;
    }
    if (listing.stock_status === 'out_of_stock' || listing.quantity < 1) {
      renderUnavailable(listing);
      return;
    }
    renderForm(listing, currentSession);
  } catch (err) {
    renderError();
  }
}

async function init() {
  currentSession = await requireAuth('login.html');
  if (!currentSession) return; // requireAuth() already redirected

  const q = new URLSearchParams(window.location.search);
  params = { medicineId: q.get('medicine_id'), pharmacyId: q.get('pharmacy_id') };

  if (!params.medicineId || !params.pharmacyId) {
    renderNotFound();
    return;
  }

  // Reload only when the failed-load state is showing; never wipe a
  // half-filled form on a connectivity blip.
  onReconnect(() => {
    if (content.querySelector('[data-retry]')) load();
  });

  load();
}

init();
