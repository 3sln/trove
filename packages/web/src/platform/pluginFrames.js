// FrameManager — the sandbox seam: everything about creating, handshaking with, and
// destroying a plugin's iframe.
//
// A plugin's code runs inside a sandboxed iframe on an OPAQUE origin (sandbox
// allow-scripts, no allow-same-origin): it can't touch the host DOM, can't read
// cookies/storage, and can't even fetch its own package files. The host injects our
// browser SDK + the plugin's entry into the frame's srcdoc; everything else flows over
// a single transferred MessagePort, capability-gated by what the user granted.
//
// Every frame — the plugin's primary (background) instance and each viewer/panel —
// comes from `spawn()`, so they all share the same wiring and capabilities.

import { RpcChannel } from '@trove/plugin-sdk/rpc.js';
import SDK_SOURCE from '@trove/plugin-sdk/browser.js' with { type: 'text' };
import { buildModuleGraph, isModuleEntry } from './pluginModules.js';

const HANDSHAKE_TIMEOUT_MS = 15000;

export class FrameManager {
  /**
   * @param {object} deps
   * @param {import('./pluginMedia.js').MediaController} deps.media
   * @param {import('./pluginDock.js').FrameDock} deps.dock
   */
  constructor({ media, dock } = {}) {
    this.media = media;
    this.dock = dock;
  }

  /**
   * Create ONE sandboxed iframe wired with `record`'s granted capabilities, run the
   * handshake, and resolve to a live frame `{ role, iframe, channel, record }`.
   * @param {object} record the plugin runtime record
   * @param {'primary'|'viewer'} role
   * @param {{onCall:Function, onEvent:Function, online:boolean}} wiring
   */
  async spawn(record, role, wiring) {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = HIDDEN_STYLE;
    // Opaque-origin sandbox: scripts only, no same-origin, no top navigation.
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    record._srcdoc ||= await buildSrcdoc(record.manifest, record.files);
    iframe.srcdoc = record._srcdoc;
    const frame = { role, iframe, channel: null, record, place: null, dock: null, docked: false, mediaActions: null };
    document.body.appendChild(iframe);
    try {
      await this.#handshake(record, frame, wiring);
    } catch (err) {
      // Never leave a hung/failed frame's iframe (or its channel) behind.
      try { frame.channel?.dispose(); } catch { /* ignore */ }
      iframe.remove();
      throw err;
    }
    return frame;
  }

  // Resolves once the frame's plugin calls activate(); rejects (and fully cleans up
  // its global message listener + timer) on boot error, iframe error, or timeout.
  #handshake(record, frame, { onCall, onEvent, online }) {
    return new Promise((resolve, reject) => {
      const { iframe } = frame;
      const manifest = record.manifest;
      let settled = false;
      let timer = 0;
      const cleanup = () => { window.removeEventListener('message', onReady); if (timer) clearTimeout(timer); };
      const fail = (msg) => { if (settled) return; settled = true; cleanup(); reject(new Error(msg)); };
      const onReady = (e) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.__trove === 'boot-error') return fail(e.data.error || 'Plugin failed to load its modules');
        if (e.data?.__trove !== 'ready') return;
        // Ready received — the transferred port takes over; stop listening globally.
        window.removeEventListener('message', onReady);
        const channel = new MessageChannel();
        frame.channel = new RpcChannel(channel.port1, {
          onCall: (m, p) => onCall(record, m, p, frame),
          onEvent: (m, p) => onEvent(record, m, p, frame),
        });
        // activate() success/failure settles this promise (and clears the timer).
        frame.resolveActivated = (f) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(f); };
        frame.rejectActivated = (err) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); reject(err); };
        // Opaque origin → target '*'; the transferred port is the real capability.
        iframe.contentWindow.postMessage(
          { __trove: 'init', manifest, capabilities: record.grants, storage: record.storage, online, role: frame.role },
          '*',
          [channel.port2],
        );
      };
      timer = setTimeout(() => fail('Plugin handshake timed out'), HANDSHAKE_TIMEOUT_MS);
      window.addEventListener('message', onReady);
      iframe.addEventListener('error', () => fail('Failed to load plugin iframe'));
    });
  }

  /**
   * Tear a frame down for good: stop tracking it, drop the dock/media session if it
   * held them, close its RPC channel, and remove the iframe from the DOM.
   */
  destroy(frame) {
    if (!frame) return;
    this.dock?.releaseFrame(frame);
    this.media?.releaseFrame(frame);
    try { frame.channel?.emit('deactivate'); } catch { /* ignore */ }
    try { frame.channel?.dispose(); } catch { /* ignore */ }
    frame.iframe.remove();
    frame.record?.frames?.delete(frame);
  }
}

const HIDDEN_STYLE = 'position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;';

// The frame's CSP. `connect-src 'none'` means it cannot make ANY direct network
// request (fetch/XHR/WebSocket/beacon) — all web access is brokered by the host and
// confined to the plugin's declared endpoints. img/media/font are limited to
// in-frame blob:/data: so remote loads can't be an exfiltration side-channel.
// `blob:` in script-src is only for the plugin's own package modules (below), which
// are same-origin blobs — no external code can load.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  'img-src blob: data:',
  'media-src blob: data:',
  "font-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body>`;

/** Build the iframe document — classic single-file, or ESM module mode (src/). */
export async function buildSrcdoc(manifest, files) {
  if (isModuleEntry(manifest)) return moduleBootstrapHtml(await buildModuleGraph({ manifest, files }));
  const entryJs = new TextDecoder().decode(files.get(manifest.entry) ?? new Uint8Array());
  return `${HEAD}
<script>${SDK_SOURCE}<\/script>
<script>${entryJs}<\/script>
</body></html>`;
}

// Escape a value for safe inlining inside <script> (so `</script>` and JS line
// separators in package code can't break out of the tag).
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// ESM module mode: ship every src/ module as a blob: URL and wire them with an
// import map keyed by canonical `trove:/<path>` specifiers (the specifiers in the
// code were rewritten to match). `trove` resolves to a shim over the injected SDK.
function moduleBootstrapHtml(graph) {
  const entryKey = safeJson('trove:/' + graph.entry);
  return `${HEAD}
<script>${SDK_SOURCE}<\/script>
<script id="__trove_src" type="application/json">${safeJson(graph.modules)}<\/script>
<script>
(function () {
  var src = JSON.parse(document.getElementById('__trove_src').textContent);
  var imports = {};
  for (var p in src) imports['trove:/' + p] = URL.createObjectURL(new Blob([src[p] + '\\n//# sourceURL=trove:/' + p], { type: 'text/javascript' }));
  imports['trove'] = URL.createObjectURL(new Blob(['export const activate = globalThis.trove.activate;\\nexport default globalThis.trove;'], { type: 'text/javascript' }));
  var im = document.createElement('script');
  im.type = 'importmap';
  im.textContent = JSON.stringify({ imports: imports });
  document.head.appendChild(im);
  import(${entryKey}).catch(function (e) {
    try { parent.postMessage({ __trove: 'boot-error', error: String((e && e.message) || e) }, '*'); } catch (_) {}
  });
})();
<\/script>
</body></html>`;
}
