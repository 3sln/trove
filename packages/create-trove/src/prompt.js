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
