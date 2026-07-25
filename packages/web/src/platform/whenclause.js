// A parser/evaluator for "when" clauses — the same conditional mini-language VS
// Code uses to gate commands, keybindings, and menu items on UI state. It reads
// a context (a flat key→value map from the ContextKeyService) and returns a
// boolean.
//
// Supported: bare keys (truthy), !key, ==, !=, >, <, >=, <=, =~ /re/, && , ||,
// parentheses, string/number/boolean literals. Expressions are parsed once into
// a predicate function and cached, so evaluation on every keydown is cheap.
//
// A key is either a core context key (`view.active`, `explorer.hasSelection`) or a
// contribution URI naming a plugin's `register` — `trove+contrib:acme.com/docs/busy`.
// Registers are addressed by their full URI precisely because they're contributions
// like any other: a plugin can only ever gate on a value someone declared and owns.

const cache = new Map();

export function compileWhen(expr) {
  if (!expr) return () => true;
  if (cache.has(expr)) return cache.get(expr);
  let fn;
  try {
    fn = new Parser(expr).parseExpression();
  } catch (err) {
    console.warn(`Invalid when clause: "${expr}" — ${err.message}`);
    fn = () => false;
  }
  cache.set(expr, fn);
  return fn;
}

export function evaluateWhen(expr, ctx) {
  return compileWhen(expr)(ctx || {});
}

// Note the `trove+contrib:` alternative comes before the regex-literal one: a URI's
// slashes would otherwise start a /…/ literal and swallow the rest of the expression.
const TOKEN = /\s*(=~|==|!=|>=|<=|&&|\|\||[()!<>]|trove\+contrib:[A-Za-z0-9_./-]+|\/(?:\\.|[^/])*\/|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|[A-Za-z0-9_.:-]+)/y;

class Parser {
  constructor(src) {
    this.src = src;
    this.tokens = this.#lex(src);
    this.pos = 0;
  }
  #lex(src) {
    const out = [];
    let i = 0;
    TOKEN.lastIndex = 0;
    while (i < src.length) {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(src);
      if (!m || m.index == null) {
        if (!src.slice(i).trim()) break;
        throw new Error(`Unexpected "${src.slice(i)}"`);
      }
      out.push(m[1]);
      i = TOKEN.lastIndex;
    }
    return out;
  }
  #peek() {
    return this.tokens[this.pos];
  }
  #next() {
    return this.tokens[this.pos++];
  }
  #eat(t) {
    if (this.#peek() !== t) throw new Error(`Expected "${t}"`);
    this.pos++;
  }

  parseExpression() {
    const fn = this.#or();
    if (this.pos !== this.tokens.length) throw new Error(`Trailing "${this.#peek()}"`);
    return fn;
  }
  #or() {
    let left = this.#and();
    while (this.#peek() === '||') {
      this.#next();
      const right = this.#and();
      const l = left;
      left = (c) => l(c) || right(c);
    }
    return left;
  }
  #and() {
    let left = this.#unary();
    while (this.#peek() === '&&') {
      this.#next();
      const right = this.#unary();
      const l = left;
      left = (c) => l(c) && right(c);
    }
    return left;
  }
  #unary() {
    if (this.#peek() === '!') {
      this.#next();
      const operand = this.#unary();
      return (c) => !operand(c);
    }
    return this.#comparison();
  }
  #comparison() {
    const left = this.#primary();
    const op = this.#peek();
    if (['==', '!=', '>=', '<=', '>', '<', '=~'].includes(op)) {
      this.#next();
      if (op === '=~') {
        const reTok = this.#next();
        const re = parseRegex(reTok);
        return (c) => re.test(String(left(c) ?? ''));
      }
      const right = this.#primary();
      return (c) => compare(op, left(c), right(c));
    }
    // Bare value → truthiness.
    return (c) => truthy(left(c));
  }
  #primary() {
    const t = this.#next();
    if (t === undefined) throw new Error('Unexpected end');
    if (t === '(') {
      const inner = this.#or();
      this.#eat(')');
      return inner;
    }
    if (t === 'true') return () => true;
    if (t === 'false') return () => false;
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      return () => n;
    }
    if (t[0] === "'" || t[0] === '"') {
      const s = t.slice(1, -1).replace(/\\(.)/g, '$1');
      return () => s;
    }
    // A context key.
    return (c) => c[t];
  }
}

function parseRegex(tok) {
  const m = /^\/((?:\\.|[^/])*)\/([a-z]*)$/.exec(tok);
  if (!m) throw new Error(`Bad regex ${tok}`);
  return new RegExp(m[1], m[2]);
}
function truthy(v) {
  return !(v === undefined || v === null || v === false || v === '' || v === 0);
}
function compare(op, a, b) {
  switch (op) {
    case '==': return a == b; // eslint-disable-line eqeqeq
    case '!=': return a != b; // eslint-disable-line eqeqeq
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
  }
  return false;
}
