import { Router, type RequestHandler } from 'express';
import type { Ctx } from '../middleware/context.js';
import { requirePermission } from '../middleware/context.js';

interface LayerLike { route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler & { requiredPermissions?: string[]; authRequired?: boolean } }[] } }

const TITLES: Record<string, string> = {
  'get /auth/session': 'Current session, CSRF token and signed-in user',
  'post /auth/login': 'Sign in (may answer twoFactorRequired with a challenge)',
  'post /auth/login/2fa': 'Complete sign-in with a TOTP or recovery code',
  'get /patients': 'List patients visible to the caller',
  'get /patients/{id}': 'Patient record (identifiers masked)',
  'get /consultations/{id}': 'Consultation with diagnoses, orders and prescriptions',
  'post /consultations/{id}/sign': 'Sign a consultation (locks it)',
  'post /pharmacy/prescriptions/check': 'Dry-run allergy, interaction and dose checks',
  'post /pharmacy/prescriptions': 'Issue a prescription (safety checks enforced)',
  'get /search': 'Global search across records the caller may see',
  'get /openapi.json': 'This specification',
};

const title = (method: string, path: string) => TITLES[`${method} ${path}`] ?? `${method.toUpperCase()} ${path}`;
const tagOf = (path: string) => (path.split('/').filter(Boolean)[0] ?? 'root').replace(/\{.*\}/, '');

/**
 * Builds an OpenAPI 3.0 document by introspecting the mounted routers: every path, method, path parameter and the
 * permission middleware each route declares. Request/response bodies are validated by the handlers with Zod and
 * are described generically here. The intentionally vulnerable /api/lab routes are never listed.
 */
export function buildOpenApi(routers: Router[], version = '1.1.0') {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const router of routers) {
    for (const layer of (router as unknown as { stack: LayerLike[] }).stack) {
      const route = layer.route;
      if (!route) continue;
      const oasPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      for (const method of Object.keys(route.methods)) {
        const handlers = route.stack.map((s) => s.handle);
        const perms = [...new Set(handlers.flatMap((h) => h.requiredPermissions ?? []))];
        const secured = perms.length > 0 || handlers.some((h) => h.authRequired);
        const params = [...oasPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: m[1].endsWith('ref') || m[1] === 'key' || m[1] === 'name' ? 'string' : 'integer' } }));
        const unsafe = method !== 'get';
        const responses: Record<string, unknown> = { '200': { description: 'Success' } };
        if (method === 'post') responses['201'] = { description: 'Created' };
        responses['400'] = { description: 'Validation failed' };
        if (secured) { responses['401'] = { description: 'Authentication required' }; responses['403'] = { description: 'Missing permission or CSRF token' }; }
        (paths[oasPath] ??= {})[method] = {
          summary: title(method, oasPath),
          tags: [tagOf(oasPath)],
          operationId: `${method}_${oasPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
          parameters: params,
          ...(unsafe && method !== 'delete' ? { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } } : {}),
          responses,
          security: secured ? [{ sessionCookie: [] }] : [],
          'x-required-permissions': perms,
          'x-csrf-required': unsafe,
        };
      }
    }
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'MediCore HMS API', version,
      description: 'Generated from the live routers. Authentication is a server-side session cookie (`sid`); every unsafe method also needs the `X-CSRF-Token` returned by `GET /api/auth/session`. Synthetic data only.',
    },
    servers: [{ url: '/api' }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: { securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'sid' } } },
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MediCore HMS API reference</title>
<style>
:root{color-scheme:light dark;--bg:#f6f8fa;--fg:#14202b;--card:#fff;--line:#d8dee4;--muted:#5b6773}
@media (prefers-color-scheme:dark){:root{--bg:#0e1419;--fg:#e6edf3;--card:#161d24;--line:#2a343e;--muted:#9aa7b3}}
body{margin:0;font:14px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:18px 24px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0}
h1{margin:0;font-size:18px}p{margin:4px 0;color:var(--muted)}main{max-width:1000px;margin:0 auto;padding:16px 24px 48px}
input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);margin-top:10px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:24px 0 8px}
.op{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:6px 0}
.m{font:600 11px ui-monospace,monospace;min-width:52px;text-align:center;padding:2px 6px;border-radius:4px;color:#fff}
.get{background:#2563eb}.post{background:#16a34a}.put{background:#d97706}.patch{background:#7c3aed}.delete{background:#dc2626}
.p{font:13px ui-monospace,monospace}.s{color:var(--muted);flex:1 1 220px}.perm{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}
</style></head><body>
<header><h1>MediCore HMS API reference</h1><p id="meta">Loading...</p><input id="q" type="search" placeholder="Filter by path, method, tag or permission" aria-label="Filter operations"></header>
<main id="root"></main><script src="/api/docs/viewer.js"></script></body></html>`;

const VIEWER = `(function(){
  var root=document.getElementById('root'),meta=document.getElementById('meta'),q=document.getElementById('q'),ops=[];
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
  function render(){
    var f=q.value.toLowerCase(),tag='';root.textContent='';var n=0;
    ops.forEach(function(o){
      var hay=(o.method+' '+o.path+' '+o.tag+' '+o.summary+' '+o.perms.join(' ')).toLowerCase();
      if(f&&hay.indexOf(f)<0)return;n++;
      if(o.tag!==tag){tag=o.tag;root.appendChild(el('h2','',tag))}
      var row=el('div','op');row.appendChild(el('span','m '+o.method,o.method.toUpperCase()));
      row.appendChild(el('span','p',o.path));row.appendChild(el('span','s',o.summary));
      if(o.secured&&!o.perms.length)row.appendChild(el('span','perm','signed-in'));
      o.perms.forEach(function(p){row.appendChild(el('span','perm',p))});
      if(!o.secured)row.appendChild(el('span','perm','public'));
      root.appendChild(row)});
    if(!n)root.appendChild(el('p','','No operations match.'))
  }
  fetch('/api/openapi.json',{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){
    Object.keys(d.paths).forEach(function(p){Object.keys(d.paths[p]).forEach(function(m){var o=d.paths[p][m];
      ops.push({method:m,path:p,tag:o.tags[0],summary:o.summary,perms:o['x-required-permissions']||[],secured:(o.security||[]).length>0})})});
    meta.textContent=d.info.title+' v'+d.info.version+' - '+ops.length+' operations. Unsafe methods need the X-CSRF-Token header.';render()
  }).catch(function(e){meta.textContent='Could not load the specification: '+e.message});
  q.addEventListener('input',render)
})();`;

export function docsRoutes(_ctx: Ctx, routers: () => Router[]) {
  const r = Router();
  const guard = requirePermission('config.manage');

  r.get('/openapi.json', guard, (_req, res) => { res.json(buildOpenApi(routers())); });

  r.get('/docs', guard, (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.type('html').send(PAGE);
  });
  r.get('/docs/viewer.js', guard, (_req, res) => { res.type('application/javascript').send(VIEWER); });

  return r;
}
