import { Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Thread } from '../../../core/models/email.model';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';
import { DensityMode } from '../../../core/services/layout.service';
import {
  type FolderBadgeInfo,
  getBadgeForFolderId,
  getOrderedFolderBadges,
} from '../../../shared/constants/folder-badges';
import { DEFAULT_LABEL_COLOR } from '../../../shared/constants/label-colors';

@Component({
  selector: 'app-email-list-item',
  standalone: true,
  imports: [CommonModule, RelativeTimePipe],
  templateUrl: './email-list-item.component.html',
  styleUrl: './email-list-item.component.scss',
})
export class EmailListItemComponent {
  readonly thread = input.required<Thread>();
  readonly isSelected = input<boolean>(false);
  readonly density = input<DensityMode>('comfortable');
  readonly showFolderBadge = input<boolean>(false);
  /** When set to [Gmail]/Trash, list item shows Draft/Sent/Deleted badges from thread folders. */
  readonly activeFolderId = input<string | null>(null);
  readonly clicked = output<Thread>();
  readonly starToggled = output<Thread>();

  readonly labelBadges = computed(() => {
    const labels = this.thread().labels;
    if (!labels || labels.length === 0) {
      return [];
    }
    return labels.map((label) => ({
      name: label.name,
      color: label.color || DEFAULT_LABEL_COLOR,
      gmailLabelId: label.gmailLabelId,
    }));
  });

  readonly folderBadge = computed<FolderBadgeInfo | null>(() => {
    if (!this.showFolderBadge()) {
      return null;
    }

    let folders = this.thread().folders;
    if (!folders || folders.length === 0) {
      return null;
    }

    // If draftBadge is already showing a Drafts indicator, filter [Gmail]/Drafts
    // from the candidate list so we don't render a second Drafts badge.
    if (this.draftBadge() !== null) {
      folders = folders.filter((f) => f.toLowerCase() !== '[gmail]/drafts');
      if (folders.length === 0) {
        return null;
      }
    }

    const badges = getOrderedFolderBadges(folders);
    return badges.length > 0 ? badges[0] : null;
  });

  /**
   * Show a Draft badge when the thread contains a draft message (hasDraft),
   * in all folders EXCEPT [Gmail]/Drafts itself (where it would be redundant).
   */
  readonly draftBadge = computed<FolderBadgeInfo | null>(() => {
    if (!this.thread().hasDraft) {
      return null;
    }
    const activeFolder = this.activeFolderId();
    if (activeFolder && activeFolder.toLowerCase() === '[gmail]/drafts') {
      return null;
    }
    return getBadgeForFolderId('[Gmail]/Drafts');
  });

  /** True when any message in the thread has attachments. */
  readonly hasAttachments = computed<boolean>(() => {
    return this.thread().hasAttachments === true;
  });

  getSenderName(): string {
    const participants = this.thread().participants;
    if (participants) {
      const first = participants.split(',')[0].trim();
      const nameMatch = first.match(/^(.+?)(?:\s*<.*>)?$/);
      return nameMatch?.[1] || first;
    }
    return 'Unknown';
  }

  getInitial(): string {
    const name = this.getSenderName();
    return name.charAt(0).toUpperCase();
  }

  onStarClick(event: Event): void {
    event.stopPropagation();
    this.starToggled.emit(this.thread());
  }
}
