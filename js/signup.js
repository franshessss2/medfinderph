// js/signup.js — signup page only.
import { db } from './supabase-client.js';

const form = document.getElementById('signup-form');
const errorEl = document.getElementById('form-error');
const submitBtn = document.getElementById('submit-btn');
const consentBox = document.getElementById('privacy_consent');
const passwordToggles = document.querySelectorAll('[data-password-toggle]');

function setPasswordVisibility(toggle, visible) {
  const input = document.getElementById(toggle.dataset.passwordToggle);
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;

  input.type = visible ? 'text' : 'password';
  toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.querySelector('.eye-icon').hidden = visible;
  toggle.querySelector('.eye-off-icon').hidden = !visible;

  input.setSelectionRange(selectionStart, selectionEnd);
}

passwordToggles.forEach((toggle) => {
  toggle.addEventListener('click', () => {
    setPasswordVisibility(toggle, toggle.getAttribute('aria-pressed') !== 'true');
  });
});

function hidePasswords() {
  passwordToggles.forEach((toggle) => setPasswordVisibility(toggle, false));
}

window.addEventListener('pageshow', hidePasswords);

// The button mirrors the checkbox; the real gate is the check in the
// submit handler and the CONSENT_REQUIRED guard in handle_new_user().
consentBox?.addEventListener('change', () => {
  submitBtn.disabled = !consentBox.checked;
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
  submitBtn.disabled = isLoading || !consentBox.checked;
  submitBtn.classList.toggle('is-loading', isLoading);
  submitBtn.textContent = isLoading ? 'Creating account…' : 'Create account';
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  hidePasswords();
  clearError();

  const full_name = form.full_name.value.trim();
  const email = form.email.value.trim();
  const phone = form.phone.value.trim();
  const password = form.password.value;
  const confirmPassword = form.confirm_password.value;

  if (!consentBox.checked) {
    showError('Accept the Privacy Notice to create an account.');
    return;
  }

  if (!full_name || !email || !phone || !password) {
    showError('Fill in every field.');
    return;
  }
  if (password.length < 6) {
    showError('Password must be at least 6 characters.');
    return;
  }
  if (password !== confirmPassword) {
    showError('Passwords do not match.');
    return;
  }

  setLoading(true);
  try {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: {
        // Read by the handle_new_user() trigger (supabase/schema.sql) to
        // populate profiles.full_name / profiles.phone — this is the only
        // path that field ever gets set through, there's no separate
        // "update my profile" step in this build.
        data: { full_name, phone, privacy_consent: true },
      },
    });

    if (error) {
      // Raw database errors ("Database error saving new user") are not
      // user-facing; map the ones a person can act on.
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('already registered')) showError('An account with this email already exists. Log in instead.');
      else if (msg.includes('password')) showError(error.message);
      else showError('Could not create your account. Check your details and try again.');
      setLoading(false);
      return;
    }

    // With email confirmation OFF, signUp() returns a live session and we
    // can go straight to the dashboard. With it ON, there's a user but no
    // session yet — send them to log in instead of a page they can't
    // actually reach.
    if (data.session) {
      window.location.href = 'dashboard.html';
    } else {
      window.location.href = 'login.html?justSignedUp=1';
    }
  } catch (err) {
    console.error('signUp threw:', err);
    showError('Something went wrong. Check your connection and try again.');
    setLoading(false);
  }
});
