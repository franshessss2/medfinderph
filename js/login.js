// js/login.js — login page only.
import { db, getProfile } from './supabase-client.js';

const form = document.getElementById('login-form');
const errorEl = document.getElementById('form-error');
const infoEl = document.getElementById('form-info');
const submitBtn = document.getElementById('submit-btn');

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
  submitBtn.textContent = isLoading ? 'Logging in…' : 'Log in';
}

/**
 * Reads ?justSignedUp=1, set by signup.js when a project has email
 * confirmation on (no session yet, so signup.js sends the person here
 * instead of a dashboard they can't reach). Shown once, not persisted.
 */
function showSignupNoticeIfPresent() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('justSignedUp') === '1') {
    infoEl.textContent = 'Account created. If email confirmation is required, check your inbox, then log in below.';
    infoEl.hidden = false;
  }
}
showSignupNoticeIfPresent();

/**
 * Where a signed-in user belongs — admin/dashboard.html for admins,
 * the regular dashboard for everyone else. Falls back to the regular
 * dashboard if the profile lookup fails, rather than blocking login.
 */
async function destination() {
  const profile = await getProfile();
  return profile?.role === 'admin' ? 'admin/dashboard.html' : 'dashboard.html';
}

/**
 * If a session already exists (e.g. the person hit "back" after logging
 * in, or is already signed in from an earlier visit), skip the form
 * entirely instead of asking them to log in twice.
 */
async function redirectIfAlreadySignedIn() {
  try {
    const { data, error } = await db.auth.getSession();
    if (!error && data.session) {
      window.location.href = await destination();
    }
  } catch (err) {
    // Placeholder/misconfigured Supabase keys, or offline — fall through
    // to showing the normal login form rather than breaking the page.
    console.error('getSession threw on login page:', err);
  }
}
redirectIfAlreadySignedIn();

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const email = form.email.value.trim();
  const password = form.password.value;

  if (!email || !password) {
    showError('Enter your email and password.');
    return;
  }

  setLoading(true);
  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      // Supabase returns the same generic message for "wrong password"
      // and "no such account" — don't narrow it further ourselves, that
      // would let this form be used to check which emails are registered.
      showError(error.message || 'Could not log in. Check your email and password.');
      setLoading(false);
      return;
    }
    window.location.href = await destination();
  } catch (err) {
    console.error('signInWithPassword threw:', err);
    showError('Something went wrong. Check your connection and try again.');
    setLoading(false);
  }
});
