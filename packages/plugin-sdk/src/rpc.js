// A minimal, symmetric JSON-RPC-ish channel over a MessagePort. Used on both
// ends of the host↔plugin boundary: the host keeps one port, the sandboxed
// iframe gets the other (transferred cross-origin at init), so neither side ever
// touches the other's globals — everything is messages. Requests get a reply;
// events are fire-and-forget. Handlers may be async and may throw; the error is
// serialized (code/message) back to the caller as a rejected promise.

export class RpcChannel {
  /**
   * @param {MessagePort|Window} port  a MessagePort (preferred) or window
   * @param {object} [opts]
   * @param {(method:string, params:any) => any} [opts.onCall] handler for incoming requests
   * @param {(method:string, params:any) => void} [opts.onEvent] handler for incoming events
   * @param {string} [opts.targetOrigin] required when port is a Window
   */
  constructor(port, opts = {}) {
    this.port = port;
    this.onCall = opts.onCall;
    this.onEvent = opts.onEvent;
    this.targetOrigin = opts.targetOrigin;
    this.seq = 0;
    this.pending = new Map();
    this._listener = (e) => this._receive(e.data, e);
    if (typeof port.addEventListener === 'function') port.addEventListener('message', this._listener);
    else port.onmessage = this._listener;
    port.start?.();
  }

  _post(msg, transfer) {
    if (this.targetOrigin) this.port.postMessage(msg, this.targetOrigin, transfer);
    else this.port.postMessage(msg, transfer);
  }

  /** Call a remote method, awaiting its result. */
  call(method, params, { timeout = 30000, transfer } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`RPC timeout: ${method}`));
          }, timeout)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this._post({ __trove: 'req', id, method, params }, transfer);
    });
  }

  /** Fire an event; no reply expected. */
  emit(method, params, transfer) {
    this._post({ __trove: 'event', method, params }, transfer);
  }

  async _receive(msg, event) {
    if (!msg || msg.__trove == null) return;
    if (msg.__trove === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.__trove === 'event') {
      try {
        await this.onEvent?.(msg.method, msg.params, event);
      } catch (err) {
        console.error('rpc event handler error', err);
      }
      return;
    }
    if (msg.__trove === 'req') {
      let result, error;
      try {
        result = await this.onCall?.(msg.method, msg.params, event);
      } catch (err) {
        error = { message: err?.message || String(err), code: err?.code || 'error' };
      }
      this._post({ __trove: 'res', id: msg.id, result, error });
    }
  }

  dispose() {
    if (typeof this.port.removeEventListener === 'function') {
      this.port.removeEventListener('message', this._listener);
    }
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('RPC channel disposed'));
    }
    this.pending.clear();
    this.port.close?.();
  }
}
