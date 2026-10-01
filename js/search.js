// js/search.js — search results page. Public: no requireAuth() call,
// since anyone should be able to search and compare before signing up.
import { db, getSession } from './supabase-client.js';
import { escapeHtml, formatPeso, statusPillHtml, freshnessHtml, rxTagHtml, skeletonHtml, errorStateHtml } from './utils.js';
import { onReconnect } from './connection.js';

const resultsContainer = document.getElementById('results-container');
const searchInput = document.getElementById('q');

/**
 * Mirrors landing.js's nav-swap. Duplicated rather than shared: it's a
 * handful of lines, and keeping each page's nav behavior self-contained
 * means a future change to one page can't silently affect another.
 */
async function reflectAuthNav() {
  const session = await getSession();
  if (!session) return;
  const actions = document.getElementById('nav-actions');
  if (actions) {
    actions.innerHTML = '<a class="btn btn-ghost" href="dashboard.html">My reservations</a>';
  }
}

/**
 * Up to 3 pharmacy listings for one medicine — best availability first
 * (in stock > low stock > out of stock), cheapest first within the same
 * status. pharmacy_stock/pharmacies are public-read tables, so this
 * works the same for signed-out visitors as signed-in ones.
 */
async function fetchTopPharmacies(medicineId) {
  try {
    const { data, error } = await db
      .from('pharmacy_stock')
      .select('price, stock_status, updated_at, medicines ( requires_prescription ), pharmacies ( id, name, location )')
      .eq('medicine_id', medicineId);

    if (error) {
      console.error('fetchTopPharmacies failed:', error.message);
      throw error;
    }

    const statusRank = { in_stock: 0, low_stock: 1, out_of_stock: 2 };
    return (data || [])
      .filter((row) => row.pharmacies) // guard against a stock row whose pharmacy was deleted
      .sort((a, b) => {
        const rankDiff = statusRank[a.stock_status] - statusRank[b.stock_status];
        return rankDiff !== 0 ? rankDiff : a.price - b.price;
      })
      .slice(0, 3);
  } catch (err) {
    console.error('fetchTopPharmacies threw:', err);
    throw err;
  }
}

function renderPrompt() {
  resultsContainer.innerHTML = `
    <div class="search-prompt">
      <h2>Search for a medicine</h2>
      <p>Try a brand name like "Biogesic" or a generic name like "Paracetamol".</p>
    </div>
  `;
}

function renderEmpty(term) {
  resultsContainer.innerHTML = `
    <div class="search-empty">
      <h2>No matches for "${escapeHtml(term)}"</h2>
      <p>Check the spelling, or try a shorter or more generic name.</p>
    </div>
  `;
}

let lastTerm = '';

function renderError() {
  resultsContainer.innerHTML = errorStateHtml(
    'Search is temporarily unavailable',
    navigator.onLine ? 'Try again in a moment.' : 'You are offline. Search resumes when the connection returns.'
  );
  resultsContainer.querySelector('[data-retry]')?.addEventListener('click', () => {
    if (lastTerm) runSearch(lastTerm);
  });
}

function resultCardHtml(medicineId, row) {
  const pharmacy = row.pharmacies;
  const reserveHref = `reserve.html?medicine_id=${encodeURIComponent(medicineId)}&pharmacy_id=${encodeURIComponent(pharmacy.id)}`;
  const action = row.stock_status === 'out_of_stock'
    ? '<span class="result-unavailable">Currently unavailable</span>'
    : `<a class="btn btn-primary btn-sm" href="${reserveHref}">Reserve</a>`;

  return `
    <div class="result-card card">
      <div class="result-main">
        <h3>${escapeHtml(pharmacy.name)}</h3>
        ${pharmacy.location ? `<p class="result-location">${escapeHtml(pharmacy.location)}</p>` : ''}
        <p class="result-flags">${freshnessHtml(row.updated_at)}${rxTagHtml(row.medicines?.requires_prescription)}</p>
      </div>
      <div class="result-meta">
        <span class="result-price">${formatPeso(row.price)}</span>
        ${statusPillHtml(row.stock_status)}
      </div>
      <div class="result-action">${action}</div>
    </div>
  `;
}

/** Returns '' (skip) when no pharmacy actually carries a name-matched medicine. */
async function medicineGroupHtml(medicine) {
  const pharmacies = await fetchTopPharmacies(medicine.id);
  if (pharmacies.length === 0) return '';

  const subtitle = medicine.generic_name ? `Generic: ${escapeHtml(medicine.generic_name)}` : '';

  return `
    <div class="medicine-group">
      <div class="medicine-group-head">
        <h2>${escapeHtml(medicine.name)}</h2>
        ${subtitle ? `<p>${subtitle}</p>` : ''}
      </div>
      <div class="result-list">
        ${pharmacies.map((row) => resultCardHtml(medicine.id, row)).join('')}
      </div>
    </div>
  `;
}

async function runSearch(term) {
  lastTerm = term;
  resultsContainer.innerHTML = skeletonHtml(3);

  try {
    const { data: medicines, error } = await db.rpc('search_medicines', {
      search_term: term,
      result_limit: 5,
    });

    if (error) {
      console.error('search_medicines RPC failed:', error.message);
      renderError();
      return;
    }

    if (!medicines || medicines.length === 0) {
      renderEmpty(term);
      return;
    }

    const groups = (await Promise.all(medicines.map(medicineGroupHtml))).filter(Boolean);

    if (groups.length === 0) {
      // Name matched, but no pharmacy_stock row exists for any match yet.
      renderEmpty(term);
      return;
    }

    resultsContainer.innerHTML = groups.join('');
  } catch (err) {
    console.error('runSearch threw:', err);
    renderError();
  }
}

function init() {
  reflectAuthNav();

  const params = new URLSearchParams(window.location.search);
  const term = (params.get('q') || '').trim();

  if (searchInput) searchInput.value = term;

  if (!term) {
    renderPrompt();
    return;
  }

  runSearch(term);
}

// Re-run the last search that failed while offline.
onReconnect(() => {
  if (lastTerm && resultsContainer.querySelector('[data-retry]')) runSearch(lastTerm);
});

init();
