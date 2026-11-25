### Fixes
- Fixed the mailbox list showing an error instead of an empty list when Gmail returns no body for an empty result.
- Remote images now follow only public addresses. Redirects and DNS results that point at private or local networks are refused, and more private address ranges are blocked.
- Fixed compose autosave overwriting another message's draft when you switch messages during a save. A failed save no longer appears on the wrong message.
- When a change is rejected before it runs, the list now reverts to the server's state instead of keeping the change.
- Fixed keyboard shortcut overrides that could lose changes made in quick succession or be overwritten at startup.
- Fixed PDF previews getting stuck on "Preview not available" after one document failed to load.
- Fixed selection and Escape-key handling that re-ran on every cursor move.

### Improvements
- Faster label updates and bulk message deletion during sync.
- Logs record event names only, never email senders, subjects or message content.
- Internal: Rust edition 2024 and code-structure cleanup, with no visible change.

See release assets for the Windows installers, updater package, and unsigned macOS disk image.
