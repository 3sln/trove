// The MCP wire protocol: JSON-RPC 2.0 over a single HTTP endpoint.
//
// Deliberately small. Trove is an MCP *server* exposing a handful of tools, not a
// framework, and the surface an agent actually exercises is `initialize`, `tools/list`,
// `tools/call`, and the resource pair. Everything else is answered honestly with
// "method not found" rather than half-implemented.
//
// Two shapes matter and are easy to get wrong:
//
//   - A NOTIFICATION (no `id`) gets no response body at all — 202 with nothing. Sending
//     a JSON-RPC result for `notifications/initialized` makes conformant clients treat
//     the connection as broken.
//   - A tool that FAILS is not a JSON-RPC error. It returns a normal result carrying
//     `isError: true`, because the model is supposed to see what went wrong and try
//     something else. JSON-RPC errors are reserved for the protocol itself being wrong —
//     an unknown method, malformed params — which the model cannot do anything about.

// The newest final revision at the time of writing. Older clients get their own version
// echoed back when we can speak it, which is how MCP negotiation works: the server picks
// from what the client asked for rather than forcing an upgrade.
export const LATEST_PROTOCOL = '2025-11-25';
export const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];

export const JSONRPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
export function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

/** A tool result the model can read. `isError` is how a failure reaches the model. */
export function toolText(text, { isError = false, structured } = {}) {
  return {
    content: [{ type: 'text', text: String(text) }],
    ...(structured ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

export class McpServer {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.version
   * @param {string} [opts.instructions] shown to the model once, describing the server
   */
  constructor({ name, version, instructions } = {}) {
    this.name = name || 'mcp';
    this.version = version || '0.0.0';
    this.instructions = instructions || '';
    this.tools = new Map();
    this.resourceProviders = null;
  }

  /**
   * @param {object} tool
   * @param {string} tool.name
   * @param {string} tool.description written for a MODEL to read, not a person
   * @param {object} tool.inputSchema JSON Schema for the arguments
   * @param {(args: object, ctx: object) => Promise<any>} tool.run
   * @param {boolean} [tool.readOnly] declared as a hint, and enforced by the caller
   */
  tool(tool) {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** @param {{list: Function, read: Function}} providers */
  resources(providers) {
    this.resourceProviders = providers;
    return this;
  }

  /**
   * Handle one JSON-RPC message. Returns null for notifications — the caller must send
   * no body at all, not `null` serialized.
   */
  async dispatch(msg, ctx = {}) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg?.id, JSONRPC_ERRORS.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const params = msg.params || {};

    try {
      switch (msg.method) {
        case 'initialize':
          return rpcResult(msg.id, this.#initialize(params));

        // The client telling us it is ready. Nothing to say back.
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;

        case 'ping':
          return rpcResult(msg.id, {});

        case 'tools/list':
          return rpcResult(msg.id, {
            tools: [...this.tools.values()]
              .filter((t) => !t.available || t.available(ctx))
              .map((t) => ({
                name: t.name,
                title: t.title || undefined,
                description: t.description,
                inputSchema: t.inputSchema,
                ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
              })),
          });

        case 'tools/call':
          return rpcResult(msg.id, await this.#call(params, ctx));

        case 'resources/list':
          if (!this.resourceProviders) break;
          return rpcResult(msg.id, await this.resourceProviders.list(params, ctx));

        case 'resources/read':
          if (!this.resourceProviders) break;
          return rpcResult(msg.id, await this.resourceProviders.read(params, ctx));

        // Declared as unsupported in `initialize`, so a conformant client won't ask.
        // Answered anyway, because one that does should get an empty list rather than
        // an error it treats as the connection failing.
        case 'prompts/list':
          return rpcResult(msg.id, { prompts: [] });
        case 'resources/templates/list':
          return rpcResult(msg.id, { resourceTemplates: [] });

        default:
          break;
      }
      if (isNotification) return null; // an unknown notification is not worth an error
      return rpcError(msg.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${msg.method}`);
    } catch (err) {
      if (isNotification) return null;
      // Something in the dispatch itself broke — not the tool, which handles its own
      // failures below.
      return rpcError(msg.id, JSONRPC_ERRORS.INTERNAL, err?.message || 'Internal error');
    }
  }

  #initialize(params) {
    const asked = params.protocolVersion;
    return {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
      capabilities: {
        tools: { listChanged: false },
        ...(this.resourceProviders ? { resources: { subscribe: false, listChanged: false } } : {}),
      },
      serverInfo: { name: this.name, version: this.version },
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  async #call(params, ctx) {
    const tool = this.tools.get(params.name);
    // An unknown tool IS a tool-level failure, not a protocol one: models hallucinate
    // tool names, and the useful response is one the model can read and correct from.
    if (!tool) return toolText(`No such tool: ${params.name}`, { isError: true });
    if (tool.available && !tool.available(ctx)) {
      return toolText(`The tool "${params.name}" is not available to you.`, { isError: true });
    }
    try {
      const out = await tool.run(params.arguments || {}, ctx);
      return out?.content ? out : toolText(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    } catch (err) {
      // Permission denied, file missing, drive full — all of it goes to the model as
      // readable text so it can adjust, rather than to the transport as a fault.
      return toolText(err?.message || 'The tool failed', { isError: true });
    }
  }
}
