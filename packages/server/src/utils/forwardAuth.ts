import { Request } from 'express';

export function forwardAuthHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  const csrf = req.headers['x-csrf-token'];
  if (csrf) headers['X-CSRF-TOKEN'] = Array.isArray(csrf) ? csrf[0] : csrf;

  const auth = req.headers['authorization'];
  if (auth) headers['Authorization'] = auth;

  const cookie = req.headers['cookie'];
  if (cookie) headers['Cookie'] = cookie;

  return headers;
}
