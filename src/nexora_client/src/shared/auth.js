// Auth helpers — session cookie is HttpOnly and handled by the browser;
// these wrappers just add credentials + JSON handling.
// Guest credentials are the ONLY thing kept in sessionStorage (a bearer
// token reclaiming a server-minted guest pid — never an account secret).

import { API_URL } from './config';

const GUEST_TOKEN_KEY = 'nexoraxr_guest_token';

export function getGuestToken() {
  return sessionStorage.getItem(GUEST_TOKEN_KEY) || null;
}
export function setGuestToken(t) {
  if (t) sessionStorage.setItem(GUEST_TOKEN_KEY, t);
  else sessionStorage.removeItem(GUEST_TOKEN_KEY);
}

async function api(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const getMe = () => api('/auth/me');

export const requestLink = (email, firstName, lastName, password) =>
  api('/auth/request-link', {
    method: 'POST',
    body: JSON.stringify({ email, firstName, lastName, password }),
  });

export const login = (email, password) =>
  api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const logout = () => api('/auth/logout', { method: 'POST' });

export const claimAdmin = (token) =>
  api('/auth/claim-admin', { method: 'POST', body: JSON.stringify({ token }) });

export const listUsers = () => api('/api/admin/users');

export const updateUser = (id, patch) =>
  api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteUser = (id) =>
  api(`/api/admin/users/${id}`, { method: 'DELETE' });
