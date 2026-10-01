// admin/js/dashboard.js — admin panel. requireAdmin() gated: non-admins
// (including signed-out visitors) get redirected before any of this runs.
// Four independent sections, each with its own fetch/render/error path —
// one section failing (e.g. a bad signed-URL call) never blanks the others.
import { db, requireAdmin } from '../../js/supabase-client.js';
import { escapeHtml, formatPeso, statusPillHtml, reservationStatusPillHtml, freshnessHtml, rxTagHtml, skeletonHtml, errorStateHtml } from '../../js/utils.js';

const logoutBtn = document.getElementById('logout-btn');

logoutBtn?.addEventListener('click', async () => {
  try {
    await db.auth.signOut();
  } catch (err) {
    console.error('signOut threw:', err);
  }
  window.location.href = '../index.html';
});

// -----------------------------------------------------------------------
// Tabs
// -----------------------------------------------------------------------

const tabs = document.querySelectorAll('.admin-tab');
const tabIndicator = document.querySelector('.admin-tab-indicator');

function positionIndicator(tab) {
  if (!tabIndicator || !tab) return;
  tabIndicator.style.width = `${tab.offsetWidth}px`;
  tabIndicator.style.transform = `translateX(${tab.offsetLeft}px)`;
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach((t) => {
      t.classList.toggle('is-active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.admin-panel').forEach((panel) => {
      const isTarget = panel.id === `panel-${target}`;
      panel.classList.toggle('is-active', isTarget);
      panel.hidden = !isTarget;
    });
    positionIndicator(tab);
  });
});

// Position for the default active tab on load, then re-sync once web
// fonts finish swapping in — Fraunces/Inter loading late would otherwise
// leave the indicator measured against fallback-font tab widths.
positionIndicator(document.querySelector('.admin-tab.is-active'));
window.addEventListener('load', () => positionIndicator(document.querySelector('.admin-tab.is-active')));
window.addEventListener('resize', () => positionIndicator(document.querySelector('.admin-tab.is-active')));

// -----------------------------------------------------------------------
// Shared modal shell — one overlay reused by pharmacy/medicine/stock
// add & edit forms. Callers hand it a title, a body-HTML string, and a
// submit handler; the modal doesn't know what it's editing.
// -----------------------------------------------------------------------

const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalClose = document.getElementById('modal-close');

function openModal(title, bodyHtml, onSubmit) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalOverlay.hidden = false;

  const form = modalBody.querySelector('form');
  const errorEl = modalBody.querySelector('.field-error');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorEl) errorEl.textContent = '';
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');
    }
    try {
      await onSubmit(new FormData(form));
      closeModal();
    } catch (err) {
      console.error('modal submit failed:', err.message || err);
      if (errorEl) errorEl.textContent = 'Could not save. Check the fields and try again.';
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('is-loading');
      }
    }
  });
}

function closeModal() {
  modalOverlay.hidden = true;
  modalBody.innerHTML = '';
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (event) => {
  if (event.target === modalOverlay) closeModal();
});

// -----------------------------------------------------------------------
// Reservations
// -----------------------------------------------------------------------

const RESERVATION_STATUS_ORDER = ['pending_verification', 'payment_confirmed', 'ready_for_pickup', 'completed'];
const RESERVATION_NEXT_LABEL = {
  pending_verification: 'Confirm payment',
  payment_confirmed: 'Mark ready for pickup',
  ready_for_pickup: 'Mark completed',
};

const reservationsContent = document.getElementById('reservations-content');

async function fetchReservations() {
  const { data, error } = await db
    .from('reservations')
    .select(`
      id, quantity, contact_name, contact_phone, notes, status, payment_proof_url, created_at,
      medicines ( name ),
      pharmacies ( name, location )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('fetchReservations failed:', error.message);
    throw error;
  }
  return data || [];
}

/**
 * payment-proofs is a private bucket, so each reservation's stored path
 * needs its own signed URL. Same N+1-by-design tradeoff as search.js's
 * per-medicine pharmacy lookups — result sets here are small (an admin
 * queue, not a public listing), so simplicity wins over batching.
 */
async function signProofUrl(path) {
  if (!path) return null;
  const { data, error } = await db.storage.from('payment-proofs').createSignedUrl(path, 3600);
  if (error) {
    console.error('createSignedUrl failed:', error.message);
    return null;
  }
  return data.signedUrl;
}

function proofThumbHtml(signedUrl) {
  if (!signedUrl) return '<span class="proof-thumb-none">No proof</span>';
  return `<a class="proof-thumb" href="${escapeHtml(signedUrl)}" target="_blank" rel="noopener">
    <img src="${escapeHtml(signedUrl)}" alt="Payment proof" loading="lazy" />
  </a>`;
}

function reservationAdminCardHtml(r, signedUrl) {
  const nextStatus = RESERVATION_STATUS_ORDER[RESERVATION_STATUS_ORDER.indexOf(r.status) + 1];
  const advanceBtn = nextStatus
    ? `<button class="btn btn-primary btn-sm" data-advance="${escapeHtml(r.id)}" data-next="${escapeHtml(nextStatus)}">${escapeHtml(RESERVATION_NEXT_LABEL[r.status])}</button>`
    : '';
  const cancelBtn = ['pending_verification', 'payment_confirmed', 'ready_for_pickup'].includes(r.status)
    ? `<button class="btn btn-danger btn-sm" data-cancel="${escapeHtml(r.id)}">Cancel</button>`
    : '';

  return `
    <div class="card reservation-admin-card">
      <div class="reservation-admin-top">
        <div>
          <h3>${escapeHtml(r.medicines?.name || 'Medicine')}</h3>
          <p class="admin-row-sub">${escapeHtml(r.pharmacies?.name || 'Pharmacy')}${r.pharmacies?.location ? ' · ' + escapeHtml(r.pharmacies.location) : ''}</p>
        </div>
        ${reservationStatusPillHtml(r.status)}
      </div>

      <div class="reservation-admin-meta">
        <span>Customer: <strong>${escapeHtml(r.contact_name)}</strong></span>
        <span>Phone: <strong>${escapeHtml(r.contact_phone)}</strong></span>
        <span>Qty: <strong>${escapeHtml(String(r.quantity))}</strong></span>
        <span>Reserved: <strong>${escapeHtml(new Date(r.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }))}</strong></span>
        ${r.notes ? `<span>Note: ${escapeHtml(r.notes)}</span>` : ''}
      </div>

      <div class="reservation-admin-actions">
        ${proofThumbHtml(signedUrl)}
        ${advanceBtn}
        ${cancelBtn}
      </div>
    </div>
  `;
}

function renderReservationsEmpty() {
  reservationsContent.innerHTML = `<div class="card admin-empty"><h2>No reservations yet</h2></div>`;
}

function renderReservationsError() {
  reservationsContent.innerHTML = errorStateHtml("Couldn't load reservations", 'Check your connection and try again.');
  reservationsContent.querySelector('[data-retry]')?.addEventListener('click', loadReservations);
}

async function loadReservations() {
  reservationsContent.innerHTML = skeletonHtml(3);
  try {
    const reservations = await fetchReservations();
    if (reservations.length === 0) {
      renderReservationsEmpty();
      return;
    }

    // Sign every proof URL up front, in parallel, before the first render —
    // avoids a layout jump where thumbnails pop in one at a time.
    const signedUrls = await Promise.all(reservations.map((r) => signProofUrl(r.payment_proof_url)));

    reservationsContent.innerHTML = reservations
      .map((r, i) => reservationAdminCardHtml(r, signedUrls[i]))
      .join('');

    reservationsContent.querySelectorAll('[data-advance]').forEach((btn) => {
      btn.addEventListener('click', () => advanceReservation(btn.dataset.advance, btn.dataset.next, btn));
    });
    reservationsContent.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => cancelReservation(btn.dataset.cancel, btn));
    });
  } catch (err) {
    renderReservationsError();
  }
}

async function advanceReservation(id, nextStatus, btn) {
  btn.disabled = true;
  const { error } = await db.from('reservations').update({ status: nextStatus }).eq('id', id);
  if (error) {
    console.error('advanceReservation failed:', error.message);
    window.alert('Could not update this reservation. It may already be completed or cancelled. Refresh and try again.');
    btn.disabled = false;
    return;
  }
  loadReservations();
}

// Cancelling fires the release trigger: reserved units return to stock
// exactly once (terminal states are immutable in the database).
async function cancelReservation(id, btn) {
  if (!window.confirm('Cancel this reservation and return its units to stock?')) return;
  btn.disabled = true;
  const { error } = await db.from('reservations').update({ status: 'cancelled' }).eq('id', id);
  if (error) {
    console.error('cancelReservation failed:', error.message);
    window.alert('Could not cancel this reservation. Refresh and try again.');
    btn.disabled = false;
    return;
  }
  loadReservations();
  loadStock();
}

document.getElementById('refresh-reservations-btn').addEventListener('click', loadReservations);

document.getElementById('expire-btn').addEventListener('click', async () => {
  const input = window.prompt('Cancel unverified reservations older than how many minutes?', '1440');
  if (input === null) return;
  const minutes = parseInt(input, 10);
  if (!Number.isInteger(minutes) || minutes < 1) {
    window.alert('Enter a whole number of minutes, 1 or more.');
    return;
  }
  const { data, error } = await db.rpc('expire_stale_reservations', { p_older_than_minutes: minutes });
  if (error) {
    console.error('expire_stale_reservations failed:', error.message);
    window.alert('Could not run expiry.');
    return;
  }
  window.alert(`${data} reservation(s) cancelled and returned to stock.`);
  loadReservations();
  loadStock();
});

// -----------------------------------------------------------------------
// Pharmacies
// -----------------------------------------------------------------------

const pharmaciesContent = document.getElementById('pharmacies-content');
document.getElementById('add-pharmacy-btn').addEventListener('click', () => openPharmacyModal());

async function fetchPharmacies() {
  const { data, error } = await db.from('pharmacies').select('id, name, location').order('name');
  if (error) {
    console.error('fetchPharmacies failed:', error.message);
    throw error;
  }
  return data || [];
}

function pharmacyRowHtml(p) {
  return `
    <div class="card admin-row" data-id="${escapeHtml(p.id)}">
      <div class="admin-row-main">
        <h3>${escapeHtml(p.name)}</h3>
        <p class="admin-row-sub">${escapeHtml(p.location || '—')}</p>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-ghost btn-sm" data-edit>Edit</button>
        <button class="btn btn-danger btn-sm" data-delete>Delete</button>
      </div>
    </div>
  `;
}

async function loadPharmacies() {
  try {
    const pharmacies = await fetchPharmacies();
    pharmaciesCache = pharmacies;
    pharmaciesContent.innerHTML = pharmacies.length
      ? `<div class="admin-table">${pharmacies.map(pharmacyRowHtml).join('')}</div>`
      : `<div class="card admin-empty"><h2>No pharmacies yet</h2></div>`;

    pharmaciesContent.querySelectorAll('.admin-row').forEach((row) => {
      const id = row.dataset.id;
      const pharmacy = pharmacies.find((p) => p.id === id);
      row.querySelector('[data-edit]').addEventListener('click', () => openPharmacyModal(pharmacy));
      row.querySelector('[data-delete]').addEventListener('click', () => deletePharmacy(pharmacy));
    });
  } catch (err) {
    pharmaciesContent.innerHTML = `<div class="card admin-empty"><h2>Couldn't load pharmacies</h2></div>`;
  }
}

function openPharmacyModal(pharmacy) {
  const isEdit = Boolean(pharmacy);
  openModal(
    isEdit ? 'Edit pharmacy' : 'Add pharmacy',
    `
      <form novalidate>
        <div class="field">
          <label for="pharmacy_name">Name</label>
          <input type="text" id="pharmacy_name" name="name" required value="${isEdit ? escapeHtml(pharmacy.name) : ''}" />
        </div>
        <div class="field">
          <label for="pharmacy_location">Location</label>
          <input type="text" id="pharmacy_location" name="location" value="${isEdit ? escapeHtml(pharmacy.location || '') : ''}" />
        </div>
        <p class="field-error" role="alert"></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add'}</button>
        </div>
      </form>
    `,
    async (formData) => {
      const payload = {
        name: formData.get('name').trim(),
        location: formData.get('location').trim() || null,
      };
      const { error } = isEdit
        ? await db.from('pharmacies').update(payload).eq('id', pharmacy.id)
        : await db.from('pharmacies').insert(payload);
      if (error) throw error;
      loadPharmacies();
    }
  );
  modalBody.querySelector('[data-cancel]').addEventListener('click', closeModal);
}

async function deletePharmacy(pharmacy) {
  if (!window.confirm(`Delete ${pharmacy.name}? This also removes its stock listings.`)) return;
  const { error } = await db.from('pharmacies').delete().eq('id', pharmacy.id);
  if (error) {
    console.error('deletePharmacy failed:', error.message);
    return;
  }
  loadPharmacies();
}

// -----------------------------------------------------------------------
// Medicines
// -----------------------------------------------------------------------

const medicinesContent = document.getElementById('medicines-content');
document.getElementById('add-medicine-btn').addEventListener('click', () => openMedicineModal());

async function fetchMedicines() {
  const { data, error } = await db.from('medicines').select('id, name, generic_name, description, requires_prescription').order('name');
  if (error) {
    console.error('fetchMedicines failed:', error.message);
    throw error;
  }
  return data || [];
}

function medicineRowHtml(m) {
  return `
    <div class="card admin-row" data-id="${escapeHtml(m.id)}">
      <div class="admin-row-main">
        <h3>${escapeHtml(m.name)}</h3>
        <p class="admin-row-sub">${escapeHtml(m.generic_name || '—')}${m.description ? ' · ' + escapeHtml(m.description) : ''}</p>
        ${m.requires_prescription ? `<p class="result-flags">${rxTagHtml(true)}</p>` : ''}
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-ghost btn-sm" data-edit>Edit</button>
        <button class="btn btn-danger btn-sm" data-delete>Delete</button>
      </div>
    </div>
  `;
}

async function loadMedicines() {
  try {
    const medicines = await fetchMedicines();
    medicinesCache = medicines;
    medicinesContent.innerHTML = medicines.length
      ? `<div class="admin-table">${medicines.map(medicineRowHtml).join('')}</div>`
      : `<div class="card admin-empty"><h2>No medicines yet</h2></div>`;

    medicinesContent.querySelectorAll('.admin-row').forEach((row) => {
      const id = row.dataset.id;
      const medicine = medicines.find((m) => m.id === id);
      row.querySelector('[data-edit]').addEventListener('click', () => openMedicineModal(medicine));
      row.querySelector('[data-delete]').addEventListener('click', () => deleteMedicine(medicine));
    });
  } catch (err) {
    medicinesContent.innerHTML = `<div class="card admin-empty"><h2>Couldn't load medicines</h2></div>`;
  }
}

function openMedicineModal(medicine) {
  const isEdit = Boolean(medicine);
  openModal(
    isEdit ? 'Edit medicine' : 'Add medicine',
    `
      <form novalidate>
        <div class="field">
          <label for="medicine_name">Name</label>
          <input type="text" id="medicine_name" name="name" required value="${isEdit ? escapeHtml(medicine.name) : ''}" />
        </div>
        <div class="field">
          <label for="medicine_generic">Generic name</label>
          <input type="text" id="medicine_generic" name="generic_name" value="${isEdit ? escapeHtml(medicine.generic_name || '') : ''}" />
        </div>
        <div class="field">
          <label for="medicine_description">Description</label>
          <textarea id="medicine_description" name="description" rows="3">${isEdit ? escapeHtml(medicine.description || '') : ''}</textarea>
        </div>
        <label class="consent-row" for="medicine_rx">
          <input type="checkbox" id="medicine_rx" name="requires_prescription" ${isEdit && medicine.requires_prescription ? 'checked' : ''} />
          <span>Prescription required at pickup</span>
        </label>
        <p class="field-error" role="alert"></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add'}</button>
        </div>
      </form>
    `,
    async (formData) => {
      const payload = {
        requires_prescription: formData.get('requires_prescription') === 'on',
        name: formData.get('name').trim(),
        generic_name: formData.get('generic_name').trim() || null,
        description: formData.get('description').trim() || null,
      };
      const { error } = isEdit
        ? await db.from('medicines').update(payload).eq('id', medicine.id)
        : await db.from('medicines').insert(payload);
      if (error) throw error;
      loadMedicines();
    }
  );
  modalBody.querySelector('[data-cancel]').addEventListener('click', closeModal);
}

async function deleteMedicine(medicine) {
  if (!window.confirm(`Delete ${medicine.name}? This also removes its stock listings.`)) return;
  const { error } = await db.from('medicines').delete().eq('id', medicine.id);
  if (error) {
    console.error('deleteMedicine failed:', error.message);
    return;
  }
  loadMedicines();
}

// -----------------------------------------------------------------------
// Stock
// -----------------------------------------------------------------------

const stockContent = document.getElementById('stock-content');
document.getElementById('add-stock-btn').addEventListener('click', () => openStockModal());

// Populated by loadPharmacies()/loadMedicines() — reused here for the
// stock modal's <select> options instead of a third fetch.
let pharmaciesCache = [];
let medicinesCache = [];

async function fetchStock() {
  const { data, error } = await db
    .from('pharmacy_stock')
    .select('id, price, quantity, stock_status, updated_at, pharmacy_id, medicine_id, medicines ( name ), pharmacies ( name )')
    .order('updated_at', { ascending: false });
  if (error) {
    console.error('fetchStock failed:', error.message);
    throw error;
  }
  return data || [];
}

function stockRowHtml(s) {
  return `
    <div class="card admin-row" data-id="${escapeHtml(s.id)}">
      <div class="admin-row-main">
        <h3>${escapeHtml(s.medicines?.name || 'Medicine')}</h3>
        <p class="admin-row-sub">${escapeHtml(s.pharmacies?.name || 'Pharmacy')}</p>
      </div>
      <div class="admin-row-meta">
        <span class="summary-price">${formatPeso(s.price)}</span>
        <span class="admin-qty">Qty <strong>${escapeHtml(String(s.quantity))}</strong></span>
        ${statusPillHtml(s.stock_status)}
        ${freshnessHtml(s.updated_at)}
      </div>
      <div class="admin-row-actions">
        <button class="btn btn-ghost btn-sm" data-edit>Edit</button>
        <button class="btn btn-danger btn-sm" data-delete>Delete</button>
      </div>
    </div>
  `;
}

async function loadStock() {
  try {
    const stock = await fetchStock();
    stockContent.innerHTML = stock.length
      ? `<div class="admin-table">${stock.map(stockRowHtml).join('')}</div>`
      : `<div class="card admin-empty"><h2>No stock entries yet</h2></div>`;

    stockContent.querySelectorAll('.admin-row').forEach((row) => {
      const id = row.dataset.id;
      const entry = stock.find((s) => s.id === id);
      row.querySelector('[data-edit]').addEventListener('click', () => openStockModal(entry));
      row.querySelector('[data-delete]').addEventListener('click', () => deleteStock(entry));
    });
  } catch (err) {
    stockContent.innerHTML = `<div class="card admin-empty"><h2>Couldn't load stock</h2></div>`;
  }
}

function pharmacyOptionsHtml(selectedId) {
  return pharmaciesCache
    .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');
}

function medicineOptionsHtml(selectedId) {
  return medicinesCache
    .map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === selectedId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`)
    .join('');
}

function openStockModal(entry) {
  const isEdit = Boolean(entry);

  if (!isEdit && (pharmaciesCache.length === 0 || medicinesCache.length === 0)) {
    window.alert('Add at least one pharmacy and one medicine first.');
    return;
  }

  // Pharmacy/medicine are fixed once a listing exists — editing a
  // (pharmacy, medicine) pair is really "delete and re-add" given the
  // schema's unique constraint on that pair, so the edit form only
  // exposes price and stock status.
  const pairFieldsHtml = isEdit
    ? `
      <div class="field">
        <label>Pharmacy</label>
        <input type="text" value="${escapeHtml(entry.pharmacies?.name || '')}" disabled />
      </div>
      <div class="field">
        <label>Medicine</label>
        <input type="text" value="${escapeHtml(entry.medicines?.name || '')}" disabled />
      </div>
    `
    : `
      <div class="field">
        <label for="stock_pharmacy">Pharmacy</label>
        <select id="stock_pharmacy" name="pharmacy_id" required>${pharmacyOptionsHtml()}</select>
      </div>
      <div class="field">
        <label for="stock_medicine">Medicine</label>
        <select id="stock_medicine" name="medicine_id" required>${medicineOptionsHtml()}</select>
      </div>
    `;

  openModal(
    isEdit ? 'Edit stock entry' : 'Add stock entry',
    `
      <form novalidate>
        ${pairFieldsHtml}
        <div class="field">
          <label for="stock_price">Price (₱)</label>
          <input type="number" id="stock_price" name="price" min="0" step="0.01" required value="${isEdit ? escapeHtml(String(entry.price)) : ''}" />
        </div>
        <div class="field">
          <label for="stock_quantity">Quantity on hand</label>
          <input type="number" id="stock_quantity" name="quantity" min="0" step="1" required value="${isEdit ? escapeHtml(String(entry.quantity)) : '0'}" />
          <span class="field-hint">Status is derived: 0 out of stock, 1–5 low stock, 6+ in stock.</span>
        </div>
        <p class="field-error" role="alert"></p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add'}</button>
        </div>
      </form>
    `,
    async (formData) => {
      if (isEdit) {
        const { error } = await db
          .from('pharmacy_stock')
          .update({
            price: Number(formData.get('price')),
            quantity: Number.parseInt(formData.get('quantity'), 10),
          })
          .eq('id', entry.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('pharmacy_stock').insert({
          pharmacy_id: formData.get('pharmacy_id'),
          medicine_id: formData.get('medicine_id'),
          price: Number(formData.get('price')),
          quantity: Number.parseInt(formData.get('quantity'), 10),
        });
        if (error) throw error;
      }
      loadStock();
    }
  );
  modalBody.querySelector('[data-cancel]').addEventListener('click', closeModal);
}

async function deleteStock(entry) {
  if (!window.confirm(`Remove ${entry.medicines?.name || 'this medicine'} from ${entry.pharmacies?.name || 'this pharmacy'}?`)) return;
  const { error } = await db.from('pharmacy_stock').delete().eq('id', entry.id);
  if (error) {
    console.error('deleteStock failed:', error.message);
    return;
  }
  loadStock();
}

// -----------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------

async function init() {
  const profile = await requireAdmin('../index.html');
  if (!profile) return; // requireAdmin() already redirected

  // Independent loads: one section's failure (caught inside each
  // load* function) never blocks the others from rendering.
  loadReservations();
  await Promise.all([loadPharmacies(), loadMedicines()]);
  loadStock();
}

init();