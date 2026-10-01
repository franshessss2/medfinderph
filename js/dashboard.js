// js/dashboard.js — customer dashboard page. requireAuth() gated, same as
// reserve.js. Two independent data sources rendered into two separate
// containers (reservations list, notification panel) so a failure in one
// fetch doesn't blank out the other.
import { db, requireAuth } from './supabase-client.js';
import { escapeHtml, formatPeso, reservationStatusPillHtml, skeletonHtml, errorStateHtml, rpcErrorText, DISCLAIMER_TEXT } from './utils.js';
import { onReconnect } from './connection.js';

const reservationsList = document.getElementById('reservations-list');
const reservedBanner = document.getElementById('reserved-banner');
const logoutBtn = document.getElementById('logout-btn');

const notifToggle = document.getElementById('notif-toggle');
const notifDot = document.getElementById('notif-dot');
const notifPanel = document.getElementById('notif-panel');
const notifList = document.getElementById('notif-list');
const notifMarkAll = document.getElementById('notif-mark-all');

logoutBtn?.addEventListener('click', async () => {
  try {
    await db.auth.signOut();
  } catch (err) {
    console.error('signOut threw:', err);
  }
  window.location.href = 'index.html';
});

/** "3h ago" / "5d ago" style — good enough for a notification feed; no
 * library pulled in for something this small. */
function relativeTime(isoString) {
  const then = new Date(isoString).getTime();
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

/**
 * Reservations joined with medicine/pharmacy names in one query —
 * mirrors the nested-select pattern in reserve.js's fetchListing().
 * Newest first: a customer's most recent reservation is the one they
 * came here to check on.
 */
async function fetchReservations(userId) {
  const { data, error } = await db
    .from('reservations')
    .select('id, quantity, contact_name, contact_phone, notes, status, created_at, medicines ( name ), pharmacies ( name, location )')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('fetchReservations failed:', error.message);
    throw error;
  }
  return data || [];
}

async function fetchNotifications(userId) {
  const { data, error } = await db
    .from('notifications')
    .select('id, message, read_bool, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('fetchNotifications failed:', error.message);
    return null; // notifications are secondary — a failed fetch shouldn't block the page
  }
  return data || [];
}

function renderReservationsEmpty() {
  reservationsList.innerHTML = `
    <div class="card dashboard-empty">
      <h2>No reservations yet</h2>
      <p>Search for a medicine to reserve it for pickup.</p>
      <a class="btn btn-primary" href="search.html">Search medicines</a>
    </div>
  `;
}

function renderReservationsError() {
  reservationsList.innerHTML = errorStateHtml(
    "Couldn't load your reservations",
    navigator.onLine ? 'Try again in a moment.' : 'You are offline. This list reloads when the connection returns.'
  );
  reservationsList.querySelector('[data-retry]')?.addEventListener('click', () => {
    reservationsList.innerHTML = skeletonHtml(3);
    refresh();
  });
}

function reservationCardHtml(r) {
  return `
    <div class="card reservation-card">
      <div class="reservation-card-top">
        <div>
          <h3>${escapeHtml(r.medicines?.name || 'Medicine')}</h3>
          <p class="reservation-sub">${escapeHtml(r.pharmacies?.name || 'Pharmacy')}${r.pharmacies?.location ? ' · ' + escapeHtml(r.pharmacies.location) : ''}</p>
        </div>
        ${reservationStatusPillHtml(r.status)}
      </div>
      <div class="reservation-meta">
        <span>Qty: <strong>${escapeHtml(String(r.quantity))}</strong></span>
        <span>Reserved: <strong>${escapeHtml(new Date(r.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }))}</strong></span>
        ${r.notes ? `<span>Note: ${escapeHtml(r.notes)}</span>` : ''}
      </div>
      ${r.status === 'pending_verification'
        ? `<div class="reservation-actions"><button type="button" class="btn btn-ghost btn-sm" data-cancel="${escapeHtml(r.id)}">Cancel reservation</button></div>`
        : ''}
    </div>
  `;
}

function renderReservations(reservations) {
  if (reservations.length === 0) {
    renderReservationsEmpty();
    return;
  }
  reservationsList.innerHTML = `<div class="reservation-list">${reservations.map(reservationCardHtml).join('')}</div>`;
  reservationsList.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => cancelReservation(btn.dataset.cancel, btn));
  });
}

async function cancelReservation(id, btn) {
  if (!window.confirm('Cancel this reservation? The reserved units go back to the pharmacy.')) return;
  btn.disabled = true;
  const { error } = await db.rpc('cancel_reservation', { p_reservation_id: id });
  if (error) {
    console.error('cancel_reservation failed:', error.message);
    window.alert(rpcErrorText(error));
    btn.disabled = false;
    return;
  }
  refresh();
}

function notifItemHtml(n) {
  return `
    <div class="notif-item ${n.read_bool ? 'is-read' : ''}" data-id="${escapeHtml(n.id)}">
      <span class="notif-item-dot"></span>
      <div>
        <div class="notif-item-message">${escapeHtml(n.message)}</div>
        <div class="notif-item-time">${escapeHtml(relativeTime(n.created_at))}</div>
      </div>
    </div>
  `;
}

let notifState = [];

function renderNotifications(notifications) {
  notifState = notifications;
  const unreadCount = notifications.filter((n) => !n.read_bool).length;
  notifDot.hidden = unreadCount === 0;
  notifMarkAll.disabled = unreadCount === 0;

  notifList.innerHTML = notifications.length
    ? notifications.map(notifItemHtml).join('')
    : '<p class="notif-empty">No notifications yet.</p>';
}

async function markRead(ids) {
  if (ids.length === 0) return;
  const { error } = await db.from('notifications').update({ read_bool: true }).in('id', ids);
  if (error) {
    console.error('markRead failed:', error.message);
    return;
  }
  renderNotifications(notifState.map((n) => (ids.includes(n.id) ? { ...n, read_bool: true } : n)));
}

function wireNotifPanel() {
  notifToggle.addEventListener('click', () => {
    const open = notifPanel.hidden;
    notifPanel.hidden = !open;
    notifToggle.setAttribute('aria-expanded', String(open));
  });

  notifMarkAll.addEventListener('click', () => {
    markRead(notifState.filter((n) => !n.read_bool).map((n) => n.id));
  });

  // Delegated: survives the re-render that every poll performs.
  notifList.addEventListener('click', (event) => {
    const item = event.target.closest('.notif-item:not(.is-read)');
    if (item) markRead([item.dataset.id]);
  });
}

// ---------------------------------------------------------------------
// Live refresh. Status changes made by an admin (web or otherwise) show
// up without a page reload: poll every 5s while the tab is visible.
// Polling, not Realtime — no publication config to get wrong, and the
// same behavior on every deployment. A render happens only when the
// payload changed, so the list never flickers or steals a click.
// ---------------------------------------------------------------------

const POLL_MS = 5000;
let currentUserId = null;
let pollTimer = null;
let lastKey = '';
let refreshing = false;

async function refresh() {
  if (refreshing || !currentUserId || !navigator.onLine) return;
  refreshing = true;
  try {
    const [reservations, notifications] = await Promise.all([
      fetchReservations(currentUserId).then((r) => ({ ok: true, data: r }), () => ({ ok: false })),
      fetchNotifications(currentUserId),
    ]);

    if (!reservations.ok) {
      // Keep showing the last good list on a background failure; only
      // replace the screen with the error state if nothing rendered yet.
      if (!lastKey) renderReservationsError();
      return;
    }

    const notifs = notifications ?? notifState; // keep last good list on a failed fetch
    const key = JSON.stringify([reservations.data, notifs]);
    if (key !== lastKey) {
      lastKey = key;
      renderReservations(reservations.data);
      renderNotifications(notifs);
    }
  } finally {
    refreshing = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    refresh();
    startPolling();
  }
});

async function init() {
  const session = await requireAuth('login.html');
  if (!session) return; // requireAuth() already redirected
  currentUserId = session.user.id;

  if (new URLSearchParams(window.location.search).get('reserved') === '1') {
    reservedBanner.textContent =
      "Reservation submitted. We'll notify you once payment is confirmed. " + DISCLAIMER_TEXT;
    reservedBanner.hidden = false;
  }

  reservationsList.innerHTML = skeletonHtml(3);
  wireNotifPanel();
  onReconnect(refresh);

  await refresh();
  startPolling();
}

init();
