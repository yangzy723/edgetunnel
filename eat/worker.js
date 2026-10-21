import {
  eatPoolAPI,
  eatMealsAPI
} from './api.js';
import {
  EAT_HTML, EAT_ETAG
} from './page.js';
// Returning null delegates the original Request, env and ctx to the host application.
export async function handleEat(request, env) {
  if ((request.headers.get('Upgrade') || '').trim()) return null;
  const {
    pathname
  } = new URL(request.url);
  if (pathname === '/eat/api/pool') return eatPoolAPI(request, env);
  if (pathname === '/eat/api/meals') return eatMealsAPI(request, env);
  if ((pathname === '/eat' || pathname === '/eat/') &&
    (request.method === 'GET' || request.method === 'HEAD')) {
    const html = EAT_HTML;
    const etag = EAT_ETAG;
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'ETag': etag,
    };
    const matches = (request.headers.get('If-None-Match') || '').split(',').some(value =>
      value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
    if (matches) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : html, { headers });
  }
  return null;
}

// Also works without the upstream project, as a separate Pages/Workers application.
export default {
  async fetch(request, env, ctx) {
    const response = await handleEat(request, env, ctx);
    if (response) return response;
    const url = new URL(request.url);
    if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method)) {
      return Response.redirect(new URL('/eat', url).href, 302);
    }
    return new Response('Not found', {
      status: 404
    });
  },
};
