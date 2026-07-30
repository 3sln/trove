// Which kinds of backing store this deployment can have.
//
// A collection IS a store config — `{ driver: 's3', bucket: … }` — and something has to
// turn that into a StorageBackend. That something used to be a three-case `switch` in the
// server, which had two problems beyond being closed:
//
//   Its `default:` arm returned MemoryStorage. So `driver: 'flesystem'` — a typo — built a
//   store that accepted writes and lost them on restart. A misconfiguration that looks
//   like it worked is worse than one that refuses to start.
//
//   The UI could not know what the server supported, so it hardcoded its own list and
//   offered Filesystem / NAS on Cloudflare Workers, where there is no filesystem to
//   point at. A form offering a choice the runtime cannot honour is a form that produces
//   a broken collection.
//
// A registry fixes both by making the set of drivers DATA. Each one declares a globally
// unique key, a label, and the fields it needs — so the server answers "what can I be
// configured with" and the client renders that answer instead of guessing. Availability
// is not a flag on a driver, it is whether the driver was registered at all: an entry
// point registers what its runtime can actually run, so Filesystem is absent on Workers
// rather than present-and-refused, and the module is not in the bundle either.
//
// The config lives in the collection record; the implementation does not. A driver can be
// written and registered entirely outside this package.

import { TroveError } from '../errors.js';
import { StorageBackend } from './interface.js';

/**
 * One field a driver needs in order to be configured.
 *
 * This is what the UI renders and what a deploy script validates against, so it says how
 * to ASK rather than how to store: `secret` is the interesting one, because a store config
 * lives in the KV store and a field marked secret should never be echoed back to a client
 * once written.
 *
 * @typedef {object} DriverField
 * @property {string} name       key in the store config
 * @property {string} label      what to call it in a form
 * @property {'text'|'password'|'number'|'boolean'} [type]
 * @property {boolean} [required]
 * @property {boolean} [secret]  never returned once stored
 * @property {string} [placeholder]
 * @property {string} [help]     one line under the field
 */

export class StorageDriverRegistry {
  constructor(drivers = []) {
    this._drivers = new Map();
    for (const d of drivers) this.register(d);
  }

  /**
   * @param {object} driver
   * @param {string} driver.key           globally unique, and what goes in `store.driver`
   * @param {string} driver.label         for a form
   * @param {string} [driver.description] one line about what it is
   * @param {DriverField[]} [driver.fields]
   * @param {(config: object) => object} [driver.normalize] accept an older or alternative
   *   config shape, returning the one `fields` describes. Runs before validation, so the
   *   shape checked is the shape built from.
   * @param {(config: object) => StorageBackend} driver.create
   */
  register(driver) {
    const key = String(driver?.key ?? '').trim();
    if (!key) throw TroveError.invalid('A storage driver needs a key');
    if (typeof driver.create !== 'function') {
      throw TroveError.invalid(`Storage driver "${key}" needs a create(config) function`);
    }
    // Refused rather than overwritten. Two drivers claiming one key means one of them is
    // silently not the one being used, and which one depends on registration order.
    if (this._drivers.has(key)) {
      throw TroveError.invalid(`A storage driver is already registered as "${key}"`);
    }
    this._drivers.set(key, {
      key,
      label: driver.label || key,
      description: driver.description || '',
      fields: (driver.fields || []).map((f) => ({
        name: f.name,
        label: f.label || f.name,
        type: f.type || 'text',
        required: !!f.required,
        secret: !!f.secret,
        placeholder: f.placeholder || '',
        help: f.help || '',
      })),
      normalize: driver.normalize || null,
      create: driver.create,
    });
    return this;
  }

  has(key) {
    return this._drivers.has(key);
  }

  keys() {
    return [...this._drivers.keys()];
  }

  /**
   * One registered driver, `create` included — unlike `describe()`, which deliberately
   * strips it because it answers a client.
   *
   * For copying a driver into another registry, which is how a deployment narrows the set
   * it offers: a registry has no `unregister`, so narrowing rebuilds from what survived
   * rather than removing from what did not. Keeping removal out of this class is the point
   * — a driver disappearing from a live registry is a store that stops being buildable
   * while collections still reference it.
   */
  driver(key) {
    return this._drivers.get(key);
  }

  /**
   * What a client needs to render a form.
   *
   * Neither `create` nor `normalize`: both are behaviour, not data. JSON.stringify would
   * drop them anyway, which is exactly why they are removed here instead — a describe()
   * whose result is only serialisable by accident is one that leaks the next function
   * somebody adds into every in-process consumer.
   */
  describe() {
    return [...this._drivers.values()].map(({ create, normalize, ...rest }) => rest);
  }

  /**
   * Build the backend a store config names.
   *
   * An unknown driver throws, and says what IS available. This is the arm that used to
   * return an in-memory store.
   *
   * `normalize` runs FIRST, so a driver that accepts more than one config shape validates
   * the shape it will actually build from. Without it, required-field checks are performed
   * against a config the driver was about to rewrite — which is precisely how S3 broke:
   * `configFromEnv` nests its settings under `s3`, `create` spread that back out, and the
   * check in between looked for a top-level `bucket` that was never going to be there and
   * refused every environment-configured S3 deployment at startup.
   */
  build(config) {
    const key = config?.driver;
    if (!key) throw TroveError.invalid('A store config needs a driver');
    const driver = this._drivers.get(key);
    if (!driver) {
      throw TroveError.invalid(
        `Unknown storage driver "${key}" — this deployment has: ${this.keys().join(', ') || 'none'}`,
      );
    }
    const cfg = driver.normalize ? driver.normalize(config) : config;
    for (const f of driver.fields) {
      if (f.required && (cfg[f.name] == null || cfg[f.name] === '')) {
        throw TroveError.invalid(`Storage driver "${key}" requires "${f.name}"`);
      }
    }
    const backend = driver.create(cfg);
    if (!(backend instanceof StorageBackend)) {
      throw TroveError.invalid(`Storage driver "${key}" did not return a StorageBackend`);
    }
    return backend;
  }
}
