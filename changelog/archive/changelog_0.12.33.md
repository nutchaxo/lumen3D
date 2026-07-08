# Changelog 0.12.33 (Plateforme Web)

## [FIXED]
- **Saving Custom Views / Combinations on Edit Done:**
  - Resolved a race condition where clicking "Done" after editing a custom view would overwrite that view's newly edited parameters with the restored default/global state parameters.
  - This occurred because `_stopEditing()` notified global channel state changes via `ChannelPanel.setState()` before setting `_editingCustomId` to `null`. This triggered the synchronous/asynchronous `channels-updated` event listener, which incorrectly thought the user was still editing the custom view and replaced its state with the incoming global restored state.
  - Fixed by resetting `_editingCustomId` and `_savedGlobalState` to `null` *before* calling `ChannelPanel.setState()`.
