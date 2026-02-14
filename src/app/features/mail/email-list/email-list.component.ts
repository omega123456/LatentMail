import { Component, inject, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { EmailsStore } from '../../../store/emails.store';
import { UiStore } from '../../../store/ui.store';
import { EmailListItemComponent } from './email-list-item.component';
import { Thread } from '../../../core/models/email.model';
import { FoldersStore } from '../../../store/folders.store';

@Component({
  selector: 'app-email-list',
  standalone: true,
  imports: [CommonModule, ScrollingModule, EmailListItemComponent],
  template: `
    <div class="email-list-container">
      @if (emailsStore.loading() && emailsStore.threads().length === 0) {
        <div class="email-list-loading">
          <span class="material-symbols-outlined spinning">sync</span>
          <p>Loading emails...</p>
        </div>
      } @else if (emailsStore.isEmpty()) {
        <div class="email-list-empty">
          <span class="material-symbols-outlined">inbox</span>
          <p>No emails yet</p>
          <p class="hint">Emails will appear here after syncing</p>
        </div>
      } @else {
        <cdk-virtual-scroll-viewport
          [itemSize]="uiStore.densityHeight()"
          class="email-scroll-viewport"
          (scrolledIndexChange)="onScroll($event)"
        >
          <app-email-list-item
            *cdkVirtualFor="let thread of emailsStore.threads(); trackBy: trackByThreadId"
            [thread]="thread"
            [isSelected]="thread.gmailThreadId === emailsStore.selectedThreadId()"
            [density]="uiStore.density()"
            (clicked)="onThreadClick(thread)"
            (starToggled)="onStarToggle(thread)"
          />
        </cdk-virtual-scroll-viewport>
      }
    </div>
  `,
  styles: [`
    .email-list-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .email-scroll-viewport {
      flex: 1;
    }

    .email-list-loading, .email-list-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--color-text-tertiary);
      gap: 8px;

      .material-symbols-outlined {
        font-size: 48px;
        opacity: 0.5;
      }

      p {
        font-size: 14px;
        margin: 0;
      }

      .hint {
        font-size: 12px;
      }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `]
})
export class EmailListComponent {
  readonly emailsStore = inject(EmailsStore);
  readonly foldersStore = inject(FoldersStore);
  readonly uiStore = inject(UiStore);
  readonly threadSelected = output<Thread>();

  trackByThreadId(_index: number, thread: Thread): string {
    return thread.gmailThreadId;
  }

  onThreadClick(thread: Thread): void {
    this.threadSelected.emit(thread);
  }

  onStarToggle(thread: Thread): void {
    const accountId = thread.accountId;
    this.emailsStore.flagEmails(
      accountId,
      [thread.gmailThreadId],
      'starred',
      !thread.isStarred
    );
  }

  onScroll(index: number): void {
    const threads = this.emailsStore.threads();
    if (index > threads.length - 10 && this.emailsStore.hasMore()) {
      // Load more handled via mail-shell
    }
  }
}
