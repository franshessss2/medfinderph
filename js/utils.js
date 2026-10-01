// js/utils.js — small shared helpers with no Supabase dependency.
// Split out from supabase-client.js because these are pure display/data
// utilities, not client or session logic.

/**
 * Escapes a string for safe insertion via innerHTML. Every value that
 * ends up in a template string built from database rows goes through
 * this — pharmacy/medicine names are admin-entered, not hardcoded, so
 * treat them as untrusted the same as any other user input.
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Formats a number as Philippine peso, e.g. 125.5 -> "₱125.50". */
export function formatPeso(amount) {
  const n = Number(amount);
  if (Number.isNaN(n)) return '₱—';
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const STOCK_STATUS_LABEL = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
};

export const STOCK_STATUS_CLASS = {
  in_stock: 'status-in',
  low_stock: 'status-low',
  out_of_stock: 'status-out',
};

/**
 * Builds the .status-pill markup (the site's stock-status indicator,
 * defined in css/style.css) — shared by search results, the customer
 * dashboard, and the admin listing manager so the three surfaces never
 * drift into inconsistent status wording.
 */
export function statusPillHtml(status) {
  const cls = STOCK_STATUS_CLASS[status] || 'status-out';
  const label = STOCK_STATUS_LABEL[status] || status || 'Unknown';
  return `<span class="status-pill ${cls}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
}

export const RESERVATION_STATUS_LABEL = {
  pending_verification: 'Pending verification',
  payment_confirmed: 'Payment confirmed',
  ready_for_pickup: 'Ready for pickup',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const RESERVATION_STATUS_CLASS = {
  pending_verification: 'status-low',
  payment_confirmed: 'status-in',
  ready_for_pickup: 'status-in',
  completed: 'status-neutral',
  cancelled: 'status-out',
};

/**
 * Same shape as statusPillHtml() but for reservations.status, which has
 * its own five-value vocabulary distinct from pharmacy_stock.stock_status
 * — kept as a separate function rather than overloading statusPillHtml so
 * callers can't accidentally pass the wrong status type in.
 */
export function reservationStatusPillHtml(status) {
  const cls = RESERVATION_STATUS_CLASS[status] || 'status-neutral';
  const label = RESERVATION_STATUS_LABEL[status] || status || 'Unknown';
  return `<span class="status-pill ${cls}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
}

// ---------------------------------------------------------------------
// Defense-scope additions
// ---------------------------------------------------------------------

export const DISCLAIMER_TEXT =
  'MedFinder PH is a reservation aid, not a licensed online pharmacy. ' +
  'Payment and dispensing are completed at the partner pharmacy. ' +
  'Proof of payment upload is a prototype feature.';

export const ALLOWED_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

const PROOF_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Validates a payment-proof File. Returns an error string or null.
 * Extension comes from the MIME type, never the filename, so a renamed
 * file cannot smuggle a different type into the bucket.
 */
export function validateProofFile(file) {
  if (!file) return 'Upload your GCash payment screenshot.';
  if (!ALLOWED_PROOF_TYPES.includes(file.type)) return 'Unsupported file type. Use JPG, PNG, or WebP.';
  if (file.size > MAX_PROOF_BYTES) return 'File too large. Maximum size is 5 MB.';
  return null;
}

export function proofExtension(mime) {
  return PROOF_EXT[mime] || 'jpg';
}

/** "Updated 3h ago" / warning class when older than 24h / unknown when null. */
export function freshnessHtml(updatedAt) {
  if (!updatedAt) return '<span class="freshness freshness-stale">Update time unknown</span>';
  const ms = Date.now() - new Date(updatedAt).getTime();
  const mins = Math.floor(ms / 60000);
  let label;
  if (mins < 1) label = 'Updated just now';
  else if (mins < 60) label = `Updated ${mins}m ago`;
  else if (mins < 1440) label = `Updated ${Math.floor(mins / 60)}h ago`;
  else label = `Updated ${Math.floor(mins / 1440)}d ago`;
  const stale = mins >= 1440 ? ' freshness-stale' : '';
  return `<span class="freshness${stale}">${escapeHtml(label)}</span>`;
}

export function rxTagHtml(requiresPrescription) {
  return requiresPrescription
    ? '<span class="rx-tag">Prescription required at pickup</span>'
    : '';
}

/**
 * Maps a Supabase/PostgREST error to user-facing text. RPC errors carry
 * the contract code as the entire `message`; anything else is treated as
 * generic so raw database text never reaches the screen.
 */
const RPC_ERROR_TEXT = {
  INSUFFICIENT_STOCK: 'Not enough stock. Someone may have just reserved the last units.',
  ACTIVE_RESERVATION_LIMIT: 'You have reached the maximum number of active reservations. Complete or cancel one first.',
  INVALID_QUANTITY: 'Choose a quantity between 1 and 10.',
  PROOF_REQUIRED: 'Upload your GCash payment screenshot.',
  INVALID_PROOF_PATH: 'The payment screenshot could not be verified. Upload it again.',
  CONTACT_REQUIRED: 'Fill in your contact name and phone number.',
  LISTING_NOT_FOUND: 'That listing is no longer available.',
  CANNOT_CANCEL: 'This reservation can no longer be cancelled.',
  RESERVATION_NOT_FOUND: 'Reservation not found.',
};

export function rpcErrorCode(error) {
  const msg = (error && error.message) || '';
  return Object.prototype.hasOwnProperty.call(RPC_ERROR_TEXT, msg) || msg === 'NOT_AUTHENTICATED' ? msg : null;
}

export function rpcErrorText(error) {
  const code = rpcErrorCode(error);
  return code && RPC_ERROR_TEXT[code]
    ? RPC_ERROR_TEXT[code]
    : 'Something went wrong. Check your connection and try again.';
}

/** Skeleton rows for Loading states. */
export function skeletonHtml(rows = 3) {
  return '<div class="skeleton-list" aria-busy="true" aria-label="Loading">' +
    Array.from({ length: rows }, () => '<div class="skeleton skeleton-row"></div>').join('') +
    '</div>';
}

/** Error state with Retry; caller wires [data-retry]. */
export function errorStateHtml(title, body) {
  return `
    <div class="search-empty">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <button type="button" class="btn btn-primary btn-sm" data-retry>Retry</button>
    </div>
  `;
}
