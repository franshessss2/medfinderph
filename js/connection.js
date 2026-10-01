// js/connection.js — offline banner + network-action guard, shared by every
// page via <script type="module">. Self-contained: no Supabase dependency.
//
// - Shows a persistent banner while navigator.onLine is false.
// - Blocks submission of any <form data-requires-network> while offline
//   (capture phase, so it runs before the page's own submit handler).
// - Exposes onReconnect(cb) so pages can re-run their last failed load.

const listeners = new Set();

const banner = document.createElement('div');
banner.className = 'offline-banner';
banner.setAttribute('role', 'status');
banner.textContent = 'No internet connection';
banner.hidden = navigator.onLine;
document.body.prepend(banner);

function sync() {
  const offline = !navigator.onLine;
  banner.hidden = !offline;
  document.body.classList.toggle('is-offline', offline);
}

window.addEventListener('offline', sync);
window.addEventListener('online', () => {
  sync();
  listeners.forEach((cb) => {
    try { cb(); } catch (err) { console.error('onReconnect callback threw:', err); }
  });
});

document.addEventListener('submit', (event) => {
  if (!navigator.onLine && event.target.matches?.('form[data-requires-network]')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

sync();

export function onReconnect(cb) {
  listeners.add(cb);
}

export function isOnline() {
  return navigator.onLine;
}
