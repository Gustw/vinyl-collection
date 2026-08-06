import { Component, computed, inject, signal } from '@angular/core';
import { CollectionService } from './collection.service';

/**
 * A standing warning that the collection exists only on this device.
 *
 * A failed commit used to be reported by a line of text on the track page,
 * which disappeared the moment the user navigated away — so the natural thing
 * to do after saving (go back to the list, carry on) was also the thing that
 * hid the fact that nothing had been saved. This sits above every page and
 * stays until the change actually lands.
 *
 * It is deliberately hard to ignore and deliberately not a modal: the work is
 * safe on this machine, so blocking the user would be an overreaction, but
 * letting them close the laptop unaware would not.
 */
@Component({
  selector: 'app-sync-status',
  standalone: true,
  template: `
    @if (col.pending(); as p) {
      <div class="sync-bar" role="status">
        <span class="sync-icon" aria-hidden="true">⚠</span>
        <span class="sync-text">
          <strong>Not saved to GitHub</strong> — changed {{ age() }}, on this
          device only.
          @if (p.attempts > 1) {
            <span class="sync-dim">{{ p.attempts }} attempts.</span>
          }
          <span class="sync-dim">{{ p.lastError }}</span>
        </span>
        <button
          type="button"
          class="sync-btn"
          [disabled]="col.syncing()"
          (click)="retry()"
        >
          {{ col.syncing() ? 'Saving…' : 'Retry now' }}
        </button>
        <button
          type="button"
          class="sync-btn sync-btn-ghost"
          (click)="download()"
          title="Save tracks.txt to disk, so the change survives this browser"
        >
          Download backup
        </button>
        @if (failed()) {
          <span class="sync-dim">Still failing — check ⚙ Settings.</span>
        }
      </div>
    }
  `,
})
export class SyncStatusComponent {
  readonly col = inject(CollectionService);

  /** How long the collection has been out of sync, in words. */
  readonly age = computed(() => this.col.pendingSummary());

  /** Set when a hand-pressed retry didn't get through, so we can say so. */
  readonly failed = signal(false);

  async retry(): Promise<void> {
    this.failed.set(false);
    const ok = await this.col.retrySync();
    this.failed.set(!ok);
  }

  /**
   * Escape hatch: writes the exact file that would have been committed.
   *
   * If GitHub is unreachable for a long stretch — a revoked token, a repo
   * renamed, no connection at all — the user should not be forced to keep one
   * browser profile alive indefinitely to avoid losing an evening's work.
   */
  download(): void {
    const text = this.col.renderCurrent();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tracks.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
}


