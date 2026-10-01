// js/nav.js — mobile nav (hamburger) toggle. Not a module: no imports
// needed, so it loads with a plain <script defer> on every page.
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;

  // Log out / notification bell live in the header on desktop, but move
  // into the hamburger dropdown on mobile. These are MOVED (appendChild),
  // never cloned — dashboard.js/reserve.js attach their click listeners
  // to the one real element by id, and a clone wouldn't carry those.
  function relocateAccountControls() {
    const homeActions = document.querySelector('.nav-actions');
    if (!homeActions) return;
    const bell = document.getElementById('notif-toggle');
    const logout = document.getElementById('logout-btn');
    if (!bell && !logout) return; // page has neither — nothing to relocate

    const isMobile = window.innerWidth <= 860;
    let mobileWrap = links.querySelector('.nav-mobile-account');

    if (isMobile) {
      if (!mobileWrap) {
        mobileWrap = document.createElement('div');
        mobileWrap.className = 'nav-mobile-account';
        links.appendChild(mobileWrap);
      }
      if (bell && bell.parentElement !== mobileWrap) mobileWrap.appendChild(bell);
      if (logout && logout.parentElement !== mobileWrap) mobileWrap.appendChild(logout);
    } else {
      if (bell && bell.parentElement !== homeActions) homeActions.insertBefore(bell, homeActions.firstChild);
      if (logout && logout.parentElement !== homeActions) homeActions.appendChild(logout);
      if (mobileWrap) mobileWrap.remove();
    }
  }

  relocateAccountControls();
  window.addEventListener('resize', relocateAccountControls);

  // On mobile, inject nav-actions buttons into the open menu so they're
  // reachable — they're hidden via CSS at <860px to avoid crowding the header.
  function injectMobileActions() {
    if (window.innerWidth > 860) return;
    if (links.querySelector('.nav-mobile-actions')) return; // already injected
    const actions = document.querySelector('.nav-actions');
    if (!actions) return;
    const btns = actions.querySelectorAll('.btn:not([id="logout-btn"]):not(.nav-bell)');
    if (btns.length === 0) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'nav-mobile-actions';
    wrapper.style.cssText = 'display:flex;gap:10px;padding-top:12px;border-top:1px solid var(--line);margin-top:8px;width:100%';
    btns.forEach((btn) => wrapper.appendChild(btn.cloneNode(true)));
    links.appendChild(wrapper);
  }

  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
    if (open) injectMobileActions();
  });

  links.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      links.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
});