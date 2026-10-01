// js/landing.js — landing page only.
// Progressive enhancement: default markup shows Log in / Sign up. If a
// session already exists (Supabase persists it in localStorage), swap
// the nav actions for a dashboard link instead.
import { getSession } from './supabase-client.js';

async function reflectAuthState() {
  const session = await getSession();
  if (!session) return;

  const actions = document.getElementById('nav-actions');
  if (actions) {
    actions.innerHTML = '<a class="btn btn-ghost" href="dashboard.html">My reservations</a>';
  }
  const heroCta = document.getElementById('hero-secondary-cta');
  if (heroCta) heroCta.remove();
}

reflectAuthState();
