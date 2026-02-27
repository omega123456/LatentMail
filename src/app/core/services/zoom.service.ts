import { Injectable, inject, signal, effect, untracked } from '@angular/core';
import { ElectronService } from './electron.service';
import { SettingsStore } from '../../store/settings.store';

export const ZOOM_PRESETS: readonly number[] = [75, 80, 90, 100, 110, 125, 150];

/** Duration in milliseconds the zoom indicator is shown after a zoom change. */
const ZOOM_INDICATOR_DURATION_MS = 1500;

@Injectable({ providedIn: 'root' })
export class ZoomService {
  private readonly electronService = inject(ElectronService);
  private readonly settingsStore = inject(SettingsStore);

  /** Current zoom level as a percentage (e.g. 100 = 100%). */
  readonly zoomLevel = signal<number>(100);

  /** Whether the zoom level indicator popup should be visible. */
  readonly zoomIndicatorVisible = signal<boolean>(false);

  private zoomDismissTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Track whether a user-initiated zoom change is in progress.
   * Prevents the settings-load effect from double-applying zoom.
   */
  private applyingUserChange = false;

  /**
   * Track whether we have observed the loading cycle (loading=true then false).
   * This prevents the effect from applying the default zoom (100%) at startup
   * before loadSettings() has run — which would override the main-process
   * pre-show zoom restoration and cause a visible flash/jump.
   */
  private seenLoadingCycle = false;

  constructor() {
    // Reactively apply zoom when SettingsStore loads or updates the persisted value.
    // We guard on the loading state to avoid applying the default zoom (100%) before
    // settings have been fetched from the DB. Once the loading cycle completes, any
    // change to zoomLevel (including the initial loaded value) is applied immediately.
    effect(() => {
      const storedLevel = this.settingsStore.zoomLevel();
      const isLoading = this.settingsStore.loading();
      untracked(() => {
        if (isLoading) {
          // Settings are being fetched — mark that we've seen loading start.
          this.seenLoadingCycle = true;
          return;
        }
        // If we haven't seen a loading cycle yet, the store is in its initial
        // default state (before any loadSettings() call). Don't apply the default.
        if (!this.seenLoadingCycle && !this.applyingUserChange) {
          return;
        }
        if (!this.applyingUserChange) {
          this.zoomLevel.set(storedLevel);
          const factor = storedLevel / 100;
          this.electronService.setZoom(factor).catch(() => {
            // Zoom application is best-effort; failures are non-fatal
          });
        }
      });
    });
  }

  /**
   * Set the zoom to a specific percentage.
   * Clamps to the preset range (75–150), immediately applies the zoom,
   * updates local state, and persists to DB.
   */
  async setZoom(percentage: number): Promise<void> {
    const clampedPercentage = Math.min(150, Math.max(75, percentage));
    this.applyingUserChange = true;
    try {
      this.zoomLevel.set(clampedPercentage);
      const factor = clampedPercentage / 100;
      await this.electronService.setZoom(factor);
      await this.settingsStore.setZoomLevel(clampedPercentage);
      this.showZoomIndicator();
    } finally {
      this.applyingUserChange = false;
    }
  }

  private showZoomIndicator(): void {
    if (this.zoomDismissTimer !== null) {
      clearTimeout(this.zoomDismissTimer);
    }
    this.zoomIndicatorVisible.set(true);
    this.zoomDismissTimer = setTimeout(() => {
      this.zoomIndicatorVisible.set(false);
      this.zoomDismissTimer = null;
    }, ZOOM_INDICATOR_DURATION_MS);
  }

  /** Step zoom up to the next preset level. No-op if already at maximum. */
  async zoomIn(): Promise<void> {
    const current = this.zoomLevel();
    const currentIndex = ZOOM_PRESETS.indexOf(current);
    let nextIndex: number;
    if (currentIndex === -1) {
      // Not on a preset — find the next preset above current
      nextIndex = ZOOM_PRESETS.findIndex((preset) => preset > current);
      if (nextIndex === -1) {
        return; // Already above max preset
      }
    } else {
      nextIndex = currentIndex + 1;
      if (nextIndex >= ZOOM_PRESETS.length) {
        return; // Already at max preset
      }
    }
    await this.setZoom(ZOOM_PRESETS[nextIndex]);
  }

  /** Step zoom down to the previous preset level. No-op if already at minimum. */
  async zoomOut(): Promise<void> {
    const current = this.zoomLevel();
    const currentIndex = ZOOM_PRESETS.indexOf(current);
    let previousIndex: number;
    if (currentIndex === -1) {
      // Not on a preset — find the next preset below current
      const below = ZOOM_PRESETS.filter((preset) => preset < current);
      if (below.length === 0) {
        return; // Already below min preset
      }
      previousIndex = ZOOM_PRESETS.indexOf(below[below.length - 1]);
    } else {
      previousIndex = currentIndex - 1;
      if (previousIndex < 0) {
        return; // Already at min preset
      }
    }
    await this.setZoom(ZOOM_PRESETS[previousIndex]);
  }

  /** Reset zoom to 100%. */
  async resetZoom(): Promise<void> {
    await this.setZoom(100);
  }
}
