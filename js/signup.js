// js/signup.js — signup page only.
import { db } from './supabase-client.js';

const form = document.getElementById('signup-form');
const errorEl = document.getElementById('form-error');
const submitBtn = document.getElementById('submit-btn');
const consentBox = document.getElementById('privacy_consent');
const passwordInput = document.getElementById('password');
const confirmPasswordInput = document.getElementById('confirm_password');
const passwordError = document.getElementById('password-error');
const confirmPasswordMessage = document.getElementById('confirm-password-message');
const passwordToggles = document.querySelectorAll('[data-password-toggle]');
let confirmPasswordTouched = false;

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

function validatePassword() {
  const message = passwordInput.value.length < 6
    ? 'Password must be at least 6 characters.'
    : '';

  passwordInput.setCustomValidity(message);
  passwordInput.toggleAttribute('aria-invalid', Boolean(message));
  passwordError.textContent = message;
  return !message;
}

function validatePasswordConfirmation() {
  const shouldCompare = confirmPasswordInput.value !== '' || confirmPasswordTouched;
  const mismatch = shouldCompare && confirmPasswordInput.value !== passwordInput.value;
  const match = shouldCompare && confirmPasswordInput.value !== '' && !mismatch;
  const message = mismatch ? 'Passwords do not match.' : '';

  confirmPasswordInput.setCustomValidity(message);
  confirmPasswordInput.toggleAttribute('aria-invalid', mismatch);
  confirmPasswordMessage.classList.toggle('is-match', match);
  confirmPasswordMessage.textContent = match ? 'Passwords match.' : message;
  return !mismatch;
}

passwordInput.addEventListener('input', () => {
  validatePassword();
  validatePasswordConfirmation();
});
passwordInput.addEventListener('blur', validatePassword);
confirmPasswordInput.addEventListener('input', validatePasswordConfirmation);
confirmPasswordInput.addEventListener('blur', () => {
  confirmPasswordTouched = true;
  validatePasswordConfirmation();
});

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

  if (!consentBox.checked) {
    showError('Accept the Privacy Notice to create an account.');
    return;
  }

  confirmPasswordTouched = true;
  validatePassword();
  validatePasswordConfirmation();

  if (!form.checkValidity()) {
    showError('Check the highlighted fields and try again.');
    form.querySelector(':invalid')?.focus();
    return;
  }

  if (!full_name || !email || !phone || !password) {
    showError('Fill in every field.');
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
