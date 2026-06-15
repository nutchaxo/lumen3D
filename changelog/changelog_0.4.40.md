# Changelog 0.4.40

## [FIXED]
- **Measure Tool Labels Sync**: Fixed the cross-iframe jittering in Compare Mode (split view) where dragging a label caused it to wildly attract/repel due to continuous state syncing. State is now elegantly synced only once upon dropping the label.

## [OPTIMIZED]
- **Smart Label Collision (Dynamic Repulsion Radius)**: Measurement labels now use a dynamic "customRadius" system for collisions. 
  - While dragging a label, its effective collision radius is safely ignored (0), allowing it to glide freely and overlap others without violently pushing them away.
  - When the label is dropped, the system calculates the *intended* distance to all other labels. If the user intentionally overlapped the labels, a smaller minimum repulsion distance (`min(default_value, new_value)`) is generated just for that label.
  - If the camera rotates and the labels are pushed *closer* than this new custom distance, the repulsion effect smoothly reactivates to maintain the user's chosen distance. If they are dragged apart later, the maximum default radius restores itself automatically.
