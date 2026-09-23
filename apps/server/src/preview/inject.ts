import { Transform, type TransformCallback } from 'node:stream';
import { PREVIEW_INJECT_PATH } from '@vibe/shared';

export const INJECT_TAG = `<script src="${PREVIEW_INJECT_PATH}"></script>`;

/** How much of a streamed document we look at for a `<head>` before falling back. */
const SCAN_LIMIT = 16 * 1024;

const HEAD_RE = /<head(?:\s[^>]*)?>/i;
const HTML_RE = /<html(?:\s[^>]*)?>/i;
const DOCTYPE_RE = /^(﻿|\xEF\xBB\xBF)?\s*<!doctype[^>]*>/i;
const BODY_RE = /<body[\s>]/i;

/**
 * Finds where to insert the script in a document prefix. Returns null when more data is needed
 * (no `<head>` yet and neither the scan limit nor the end of the document is reached).
 */
export function injectionPoint(prefix: string, final: boolean): number | null {
  const head = HEAD_RE.exec(prefix);
  if (head) return head.index + head[0].length;
  if (!final && prefix.length < SCAN_LIMIT && !BODY_RE.test(prefix)) return null;
  const html = HTML_RE.exec(prefix);
  if (html) return html.index + html[0].length;
  const doctype = DOCTYPE_RE.exec(prefix);
  if (doctype) return doctype[0].length;
  return 0;
}

/** Injects the preview script into a complete HTML document (latin1/binary safe). */
export function injectHtml(html: string, tag = INJECT_TAG): string {
  const at = injectionPoint(html, true)!;
  return html.slice(0, at) + tag + html.slice(at);
}

/**
 * Streaming injector: buffers only until the insertion point is known, then passes bytes through
 * untouched (keeps streamed SSR responses streaming). Works on latin1 strings so any charset survives.
 */
export class HtmlInjector extends Transform {
  private pending = '';
  private done = false;

  constructor(private readonly tag = INJECT_TAG) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    if (this.done) return cb(null, chunk);
    this.pending += chunk.toString('latin1');
    const at = injectionPoint(this.pending, false);
    if (at === null) return cb();
    this.flushAt(at);
    cb();
  }

  override _flush(cb: TransformCallback) {
    if (!this.done) this.flushAt(injectionPoint(this.pending, true)!);
    cb();
  }

  private flushAt(at: number) {
    this.done = true;
    const out = this.pending.slice(0, at) + this.tag + this.pending.slice(at);
    this.pending = '';
    this.push(Buffer.from(out, 'latin1'));
  }
}

/** Whether a response is an HTML document we can (and should) inject into. */
export function shouldInject(method: string | undefined, status: number, headers: Record<string, unknown>): boolean {
  if (method === 'HEAD' || status === 204 || status === 304 || status < 200 || (status >= 300 && status < 400)) return false;
  const type = String(headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('text/html')) return false;
  const enc = String(headers['content-encoding'] ?? 'identity').toLowerCase().trim();
  // We asked for identity; if the dev server compressed anyway we pass the body through untouched.
  return enc === '' || enc === 'identity';
}

/**
 * Relaxes a Content-Security-Policy just enough: drops `frame-ancestors` (the app iframes the preview)
 * and makes sure `'self'` scripts (our injected script) are allowed. Returns null to drop the header.
 */
export function relaxCsp(value: string): string | null {
  const directives = value
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => !/^frame-ancestors(\s|$)/i.test(d));
  const hasScriptSrc = directives.some((d) => /^script-src(\s|$)/i.test(d));
  const out = directives.map((d) => {
    const name = d.split(/\s+/)[0]!.toLowerCase();
    const isScript = name === 'script-src' || name === 'script-src-elem' || (!hasScriptSrc && name === 'default-src');
    if (!isScript) return d;
    const sources = d.split(/\s+/).slice(1);
    if (sources.some((s) => s === "'self'" || s === '*')) return d;
    return `${d.replace(/\s*'none'/i, '')} 'self'`;
  });
  return out.length ? out.join('; ') : null;
}

/** Client script served at PREVIEW_INJECT_PATH. Posts PreviewMessages to the parent, obeys PreviewCommands. */
export const INJECT_SCRIPT = `(function () {
  'use strict';
  if (window.__vibePreview) return;
  window.__vibePreview = true;
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  function post(msg) {
    msg.source = 'vibe-preview';
    msg.ts = Date.now();
    try { parentWin.postMessage(msg, '*'); } catch (e) { /* ignore */ }
  }
  function fmt(v) {
    try {
      if (typeof v === 'string') return v.length > 10000 ? v.slice(0, 10000) + '…' : v;
      if (v instanceof Error) return v.stack || String(v);
      if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (typeof v === 'undefined') return 'undefined';
      if (typeof v === 'symbol' || typeof v === 'bigint') return String(v);
      if (typeof Element !== 'undefined' && v instanceof Element) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
      var seen = [];
      var s = JSON.stringify(v, function (k, x) {
        if (typeof x === 'object' && x !== null) { if (seen.indexOf(x) >= 0) return '[Circular]'; seen.push(x); }
        if (typeof x === 'bigint') return String(x);
        return x;
      });
      if (s === undefined) s = String(v);
      return s.length > 10000 ? s.slice(0, 10000) + '…' : s;
    } catch (e) { return String(v); }
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      try { post({ type: 'console', level: level, args: Array.prototype.map.call(arguments, fmt) }); } catch (e) { /* ignore */ }
      return orig.apply(this, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target !== window && e.target.tagName) {
      var el = e.target;
      post({ type: 'error', message: 'Ressource konnte nicht geladen werden: ' + (el.src || el.href || el.tagName) });
      return;
    }
    post({ type: 'error', message: (e && e.message) || 'Unbekannter Fehler', stack: e && e.error && e.error.stack ? String(e.error.stack) : undefined });
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    post({ type: 'error', message: 'Unbehandelte Promise-Ablehnung: ' + (r && r.message ? r.message : fmt(r)), stack: r && r.stack ? String(r.stack) : undefined });
  });
  var last = '';
  function nav(force) {
    var url = location.pathname + location.search + location.hash;
    var key = url + '\\u0000' + document.title;
    if (!force && key === last) return;
    last = key;
    post({ type: 'navigate', url: url, title: document.title || '' });
  }
  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = history[name];
    history[name] = function () {
      var r = orig.apply(this, arguments);
      try { nav(false); } catch (e) { /* ignore */ }
      return r;
    };
  });
  window.addEventListener('popstate', function () { nav(false); });
  window.addEventListener('hashchange', function () { nav(false); });
  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var d = e.data;
    if (!d || d.source !== 'vibe-parent') return;
    if (d.type === 'reload') location.reload();
    else if (d.type === 'back') history.back();
    else if (d.type === 'forward') history.forward();
  });
  function ready() {
    post({ type: 'ready', url: location.pathname + location.search + location.hash });
    nav(true);
    try {
      var t = document.querySelector('title');
      if (t && typeof MutationObserver !== 'undefined') new MutationObserver(function () { nav(false); }).observe(t, { childList: true, characterData: true, subtree: true });
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
  window.addEventListener('load', function () { nav(false); });
})();
`;
