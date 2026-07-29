// The key-rotation script that goes into a scaffolded project, as source.
//
// Vendored as text for the same reason as the local bucket: it is a template. It uses
// @3sln/trove/core, which the generated project has and the WIZARD does not — the
// wizard runs through `npm create`, before there is a node_modules to import from.
// That is why the first version of the push question pointed at a function nobody
// could call yet.

/* eslint-disable */
export const VAPID_SCRIPT = `// Mint a VAPID key pair.
//
//   npm run vapid
//
// A pair identifies THIS application server to a push service. It is self-issued — no
// account, no registration, no network — so there is nothing to fetch and nothing to
// pay for. The two halves go to different places and only one of them is a secret,
// which is what the output below is really about.
//
// Rotating invalidates every existing subscription: a browser subscribes against a
// specific public key, so after a rotation each client re-subscribes on its next load.
// That is free on a drive nobody has subscribed to yet and disruptive on one people
// use, so it is worth doing once, at the start.
import { generateVapidKeys } from '@3sln/trove/core';

const { publicKey, privateKey } = await generateVapidKeys();

console.log(\`
A new VAPID pair. The halves belong in two different places.

  PUBLIC — not a secret. Browsers receive it as applicationServerKey, so it is public
  by construction. It goes in wrangler.toml under [vars]:

    TROVE_VAPID_PUBLIC_KEY = "\${publicKey}"

  PRIVATE — signs the JWT that authorises each push. It should never be written to a
  file this project tracks:

    npx wrangler secret put TROVE_VAPID_PRIVATE_KEY

    \${privateKey}

They are a PAIR. Setting one without the other leaves the drive unable to push, and it
fails at the push service as a rejected signature rather than as anything logged here.

For local development put BOTH halves in .dev.vars, which is gitignored — a local drive
is a different application server from the deployed one, and should not share its key.
\`);
`;
