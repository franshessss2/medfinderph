// js/reveal.js — two small ambient behaviors, both progressive
// enhancement: if this script fails to load, .site-header just never
// gains .is-scrolled (no visual regression) and [data-reveal] elements
// are visible by default per the CSS fallback, not stuck at opacity 0.
// Not a module: no imports, so it loads with a plain <script defer>
// alongside js/nav.js.
document.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('.site-header');
  if (header) {
    const applyScrollState = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    applyScrollState();
    window.addEventListener('scroll', applyScrollState, { passive: true });
  }

  const revealTargets = document.querySelectorAll('[data-reveal]');
  if (revealTargets.length === 0) return;

  if (!('IntersectionObserver' in window)) {
    // No IO support: reveal everything immediately rather than leave it hidden.
    revealTargets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  revealTargets.forEach((el) => observer.observe(el));
});
