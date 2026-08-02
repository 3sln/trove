# 032 — verify that uninstalling a plugin clears any default opener pointing at it

If someone ticks "Always use this for .m4b files" against the audiobook player and then
uninstalls the plugin, what happens to the association?

## What to check

Associations live in settings under `openers.associations` (`bl/openers.js`), a map from a
type key (`.m4b`, a mime, or `type/*`) to an opener id. Uninstall goes through
`PluginService.remove` on the server and the host's uninstall path on the client.

The question is whether anything removes the entries whose opener id belonged to the
plugin. **I have not verified either way** — this ticket is to establish it, then fix it if
needed.

Three outcomes, and they want different responses:

- **Cleared already.** Add a test so it stays that way; close.
- **Left behind and harmless.** `openerAssociations` already computes a `missing` flag for
  an association naming an opener that no longer exists, and the settings screen shows it
  rather than a bare id — so the drive may simply fall back and say so. If that is the
  behaviour, decide whether a stale row is worth keeping (it becomes live again if the
  plugin is reinstalled, which is arguably a feature) and write down which it is.
- **Left behind and harmful.** Anything that resolves an association to an opener without
  checking availability, and errors or opens nothing rather than falling back.

## Notes

- Reinstalling the same plugin restores the id, so clearing eagerly loses a preference the
  user may want back. "Ignore when unavailable, show as missing, clear on request" may beat
  "delete on uninstall" — but that is a decision, and right now it is an accident.
- The same question applies to anything else keyed by plugin id and stored in settings:
  keybindings pointing at a plugin command, a default view contributed by a plugin. Worth
  checking as a class rather than one case.
