// js/supabase-client.js
// Single Supabase client instance, shared across every page via ES module import.
// Loaded after the CDN <script> tag in each HTML file, so `window.supabase`
// (the library) already exists — createClient() below builds our client from it
// and reassigns the export name to avoid shadowing the library global.

const SUPABASE_URL = 'https://utjvughkajnxknezojni.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0anZ1Z2hrYWpueGtuZXpvam5pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0MTk0NzcsImV4cCI6MjEwMTk5NTQ3N30.bQ5IG8ROIBkWDbc7ezIFb6twDO024jF59ReAR-3RVg8';

// The anon key is safe to ship in client-side code — it identifies the
// project, not a privileged credential. Row Level Security (see
// supabase/schema.sql) is what actually restricts data access per user.

export const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/**
 * Resolves once with the current session (or null). Use at the top of any
 * page that needs to know auth state before rendering.
 */
export async function getSession() {
  try {
    const { data, error } = await db.auth.getSession();
    if (error) {
      console.error('getSession failed:', error.message);
      return null;
    }
    return data.session;
  } catch (err) {
    // Network/config error (e.g. SUPABASE_URL still a placeholder) —
    // treat as "not signed in" instead of breaking the page.
    console.error('getSession threw:', err);
    return null;
  }
}

/**
 * Resolves with the caller's profile row (id, full_name, phone, role), or
 * null if not signed in. Used for role checks (customer vs admin).
 */
export async function getProfile() {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await db
    .from('profiles')
    .select('id, full_name, phone, role')
    .eq('id', session.user.id)
    .single();
  if (error) {
    console.error('getProfile failed:', error.message);
    return null;
  }
  return data;
}

/**
 * Redirects to login.html if no session exists. Call at the top of any
 * page that requires auth. Returns the session so callers don't need a
 * second getSession() round trip.
 */
export async function requireAuth(redirectTo = 'login.html') {
  const session = await getSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}

/**
 * Redirects to index.html if the signed-in user isn't an admin. Call at
 * the top of every admin/*.html page.
 */
export async function requireAdmin(redirectTo = '../index.html') {
  const profile = await getProfile();
  if (!profile || profile.role !== 'admin') {
    window.location.href = redirectTo;
    return null;
  }
  return profile;
}
