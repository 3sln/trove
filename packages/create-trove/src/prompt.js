// A prompt kit small enough to have no dependencies.
//
// `npm create` runs this before anything is installed, so every dependency here is one
// the user waits on before they have answered a single question. That budget is better
// spent on the questions themselves, and what a wizard actually needs — a line of text,
// a pick from a list, a yes/no — is a few dozen lines over readline.
//
// Everything is injectable and `scripted()` implements the same interface, so the
// wizard can be driven by a test without a terminal. That is the reason the prompter is
// passed around rather than reached for: a wizard that reads process.stdin directly can
// only be tested by a human.

import readline from 'node:readline/promises';

const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

/**
 * A prompter backed by a real terminal.
 *
 * @param {object} [opts]
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 * @param {boolean} [opts.assumeDefaults] answer every question with its default and
 *   never block — what `--yes` sets, and what a non-interactive stdin forces.
 */
export function createPrompter({ input = process.stdin, output = process.stdout, assumeDefaults = false } = {}) {
  const colour = output.isTTY && !process.env.NO_COLOR;
  const paint = (code, s) => (colour ? code + s + RESET : s);
  let rl = null;
  const lazy = () => (rl ??= readline.createInterface({ input, output }));

  const write = (s) => output.write(s + '\n');

  async function line(query) {
    if (assumeDefaults) return '';
    return (await lazy().question(query)).trim();
  }

  return {
    close() { rl?.close(); rl = null; },

    heading(text) {
      write('');
      write(paint(BOLD, text));
    },

    note(text) {
      write(paint(DIM, '  ' + text));
    },

    /**
     * Free text. An empty answer takes the default, so Enter is always the safe key.
     */
    async text(label, { default: def = '', hint } = {}) {
      if (hint) this.note(hint);
      const shown = def ? ` ${paint(DIM, `(${def})`)}` : '';
      const answer = await line(`${label}${shown}: `);
      return answer || def;
    },

    /**
     * Pick one of a list. Options are `{ value, label, hint }`.
     */
    async choice(label, options, { default: def } = {}) {
      const fallback = def ?? options[0].value;
      if (assumeDefaults) return fallback;
      write('');
      write(label);
      options.forEach((o, i) => {
        const mark = o.value === fallback ? '>' : ' ';
        write(`  ${mark} ${i + 1}) ${o.label}${o.hint ? paint(DIM, ' — ' + o.hint) : ''}`);
      });
      for (;;) {
        const raw = await line(`  choice ${paint(DIM, `(${options.findIndex((o) => o.value === fallback) + 1})`)}: `);
        if (!raw) return fallback;
        const byIndex = options[Number(raw) - 1];
        if (byIndex) return byIndex.value;
        const byValue = options.find((o) => o.value === raw.toLowerCase());
        if (byValue) return byValue.value;
        write(paint(DIM, '  Not one of the options.'));
      }
    },

    async confirm(label, { default: def = true } = {}) {
      if (assumeDefaults) return def;
      const shown = def ? 'Y/n' : 'y/N';
      for (;;) {
        const raw = (await line(`${label} ${paint(DIM, `(${shown})`)}: `)).toLowerCase();
        if (!raw) return def;
        if (['y', 'yes'].includes(raw)) return true;
        if (['n', 'no'].includes(raw)) return false;
      }
    },

    /**
     * Offer a block of related questions, or let the user take it themselves.
     *
     * Skipping is a first-class answer rather than a way of bailing out: the generated
     * files still carry the section, commented, with the variables that belong in it.
     * Someone who already knows their S3 credentials does not want to be interviewed
     * about them, and someone who does not should not be blocked from getting a
     * project on disk.
     */
    async section(title, { blurb, default: def = true } = {}) {
      this.heading(title);
      if (blurb) this.note(blurb);
      return this.confirm('  Configure this now?', { default: def });
    },
  };
}

// --- non-interactive drivers -------------------------------------------------
//
// Everything below is the same interface, which is the point: the wizard does not know
// whether a person, a test transcript, a `--set` flag or nobody at all is answering it.
//
// These two are what make the tool usable by something that is not a human. An agent
// cannot read a blurb and type a bucket name, so it supplies answers up front by key —
// `storage.bucket`, not "  Bucket". Keys are stable; the wording of a question is not,
// and pinning an interface to prose means rewording a hint breaks callers.

const TRUE = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off']);

function toBool(raw, key) {
  const v = String(raw).trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new Error(`${key}: expected a boolean, got "${raw}"`);
}

/**
 * Answer from a map of keys, and ask `inner` about anything not supplied.
 *
 * Unused keys are an error rather than a shrug — see `unused()`. A key that was never
 * consumed is either a typo or a setting that the other answers made unreachable
 * (`storage.bucket` when the backend is `filesystem`), and both are things the caller
 * wants told to them rather than silently dropped.
 *
 * @param {Record<string, string|number|boolean>} answers
 * @param {object} inner the prompter to fall back to
 */
export function presetPrompter(answers, inner) {
  const supplied = new Map(Object.entries(answers ?? {}).map(([k, v]) => [k, v]));
  const used = new Set();

  const take = (key) => {
    if (key === undefined || !supplied.has(key)) return undefined;
    used.add(key);
    return supplied.get(key);
  };

  return {
    close: () => inner.close(),
    heading: (t) => inner.heading(t),
    note: (t) => inner.note(t),
    /** Keys that were given but never asked for. */
    unused: () => [...supplied.keys()].filter((k) => !used.has(k)),

    async text(label, opts = {}) {
      const v = take(opts.key);
      return v === undefined ? inner.text(label, opts) : String(v);
    },
    async choice(label, options, opts = {}) {
      const v = take(opts.key);
      if (v === undefined) return inner.choice(label, options, opts);
      const wanted = String(v);
      if (!options.some((o) => o.value === wanted)) {
        throw new Error(`${opts.key}: "${wanted}" is not one of ${options.map((o) => o.value).join(', ')}`);
      }
      return wanted;
    },
    async confirm(label, opts = {}) {
      const v = take(opts.key);
      return v === undefined ? inner.confirm(label, opts) : toBool(v, opts.key);
    },
    async section(title, opts = {}) {
      const v = take(opts.key);
      return v === undefined ? inner.section(title, opts) : toBool(v, opts.key);
    },
  };
}

/**
 * Ask nothing, answer with defaults, and write down every question it was asked.
 *
 * This is how `--describe` works. The interview branches on its own answers, so there is
 * no static schema to print — but running it with a recorder produces the questions that
 * are actually reachable, which is the honest version of the same thing and cannot drift
 * from the code the way a hand-kept list would.
 */
export function recordingPrompter() {
  const seen = [];
  const record = (kind, label, opts, value, options) => {
    if (opts.key) seen.push({ key: opts.key, kind, label: label.trim(), default: value, ...(options ? { options } : {}) });
    return value;
  };
  return {
    close() {}, heading() {}, note() {},
    questions: () => seen,
    async text(label, opts = {}) { return record('text', label, opts, opts.default ?? ''); },
    async choice(label, options, opts = {}) {
      return record('choice', label, opts, opts.default ?? options[0].value,
        options.map((o) => ({ value: o.value, label: o.label })));
    },
    async confirm(label, opts = {}) { return record('boolean', label, opts, opts.default ?? true); },
    async section(title, opts = {}) { return record('boolean', title, opts, opts.default ?? true); },
  };
}

/**
 * A prompter that reads from a list instead of a person.
 *
 * Answers are consumed in order and matched by the question's label, so a test reads as
 * a transcript rather than as a queue of bare strings — and a wizard that grows a
 * question in the middle fails loudly instead of silently shifting every later answer
 * onto the wrong prompt.
 *
 * @param {Array<[string, any]>} script pairs of [label substring, answer]
 */
export function scripted(script) {
  const remaining = [...script];
  const take = (label, fallback) => {
    const i = remaining.findIndex(([match]) => label.includes(match));
    if (i === -1) {
      if (fallback !== undefined) return fallback;
      throw new Error(`No scripted answer for: ${label}\nRemaining: ${remaining.map(([m]) => m).join(', ')}`);
    }
    return remaining.splice(i, 1)[0][1];
  };
  return {
    close() {},
    heading() {},
    note() {},
    unanswered: () => remaining.map(([m]) => m),
    async text(label, { default: def = '' } = {}) { return take(label, def); },
    async choice(label, options, { default: def } = {}) { return take(label, def ?? options[0].value); },
    async confirm(label, { default: def = true } = {}) { return take(label, def); },
    async section(title, { default: def = true } = {}) { return take(title, def); },
  };
}
