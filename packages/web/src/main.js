// The open-source build's entry point: a workbench with nothing added to it.
//
// Everything that used to live here is `createWorkbench` (./workbench.js), which takes
// the openers and views a build wants to ship. A hosted or bespoke build imports that
// instead of this file and passes its own — no fork, and the same registry the plugins
// use.

import { createWorkbench } from './workbench.js';

createWorkbench();
