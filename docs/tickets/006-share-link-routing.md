# 006 — Share link routing

`shareUrl()`, `parseShareUrl()` and `troveUriFromShareUrl()` are written and tested. Nothing
generates a link in the UI and nothing opens one: pasting `/c/<collection>/i/<name>` into the
address bar loads the app at its default view.

## What is needed

**Producing one.** A "Copy link" on an item, alongside the existing copy of the `trove:`
URI. The two are the same address in different spellings, so they belong together and should
be labelled so it is clear which is for a document and which is for a person.

**Resolving one on load.** The app boots, sees a share path, opens that collection and that
item. Interactions worth getting right:

- The collection gate remembers the last collection and shows a chooser when there is none.
  A share link names its collection, so it should take precedence over both — arriving at a
  link and being asked to choose a collection would be absurd.
- A link naming a collection the visitor cannot read should say so plainly rather than
  showing an empty drive.
- A link by name breaks on rename, deliberately and visibly. That should read as "this item
  has been renamed or removed", not as a blank screen.

**History.** Opening an item already pushes state for the viewer stack; a share link
arriving should slot into that rather than fight it.

## Notes

- Nothing secret is in a link, including for encrypted collections. That is deliberate — a
  link is pasted into chats, logged by proxies, and kept forever. The recipient gets the item
  because they are allowed the collection.
- 002 may introduce routes of its own; the two should agree on how the app reads its URL
  rather than each growing a parser.

## Done when

A link copied from one browser opens the same item in another, and a link to something the
visitor cannot see says which of those it is.
