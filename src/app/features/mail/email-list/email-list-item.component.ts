import { Component, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Thread } from '../../../core/models/email.model';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';
import { DensityMode } from '../../../core/services/layout.service';
import {
  type FolderBadgeInfo,
  getBadgeForFolderId,
  getOrderedFolderBadges,
  HIDDEN_FOLDER_IDS,
} from '../../../shared/constants/folder-badges';

/** Folder IDs treated as Sent (for "To: …" display in list). */
const SENT_FOLDER_IDS = ['[Gmail]/Sent Mail', 'Sent', '[Gmail]/Sent'];
import { DEFAULT_LABEL_COLOR } from '../../../shared/constants/label-colors';
import { SettingsStore } from '../../../store/settings.store';
import { SenderAvatarComponent } from '../../../shared/components/sender-avatar/sender-avatar.component';

@Component({
  selector: 'app-email-list-item',
  standalone: true,
  imports: [CommonModule, RelativeTimePipe, SenderAvatarComponent],
  templateUrl: './email-list-item.component.html',
  styleUrl: './email-list-item.component.scss',
})
export class EmailListItemComponent {
  readonly settingsStore = inject(SettingsStore);
  readonly thread = input.required<Thread>();
  readonly isSelected = input<boolean>(false);
  readonly density = input<DensityMode>('comfortable');
  readonly showFolderBadge = input<boolean>(false);
  /** When set to [Gmail]/Trash, list item shows Draft/Sent/Deleted badges from thread folders. */
  readonly activeFolderId = input<string | null>(null);
  /** When false (e.g. when viewing Trash), the star icon and toggle are hidden. */
  readonly showStarAction = input<boolean>(true);
  /** When true, show Material-style skeleton loading state (used for streamed-in search results). */
  readonly newlyAdded = input<boolean>(false);
  /** Whether this item is part of the active multi-selection. */
  readonly isMultiSelected = input<boolean>(false);
  readonly clicked = output<{ thread: Thread; ctrlKey: boolean; shiftKey: boolean }>();
  readonly starToggled = output<Thread>();
  readonly contextMenuRequested = output<{ thread: Thread; x: number; y: number }>();

  readonly labelBadges = computed(() => {
    const labels = this.thread().labels;
    if (!labels || labels.length === 0) {
      return [];
    }
    return labels
      .filter((label) => !HIDDEN_FOLDER_IDS.has(label.gmailLabelId.toLowerCase()))
      .map((label) => ({
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

  getSenderEmail(): string | null {
    const participants = this.thread().participants;
    if (!participants) {
      return null;
    }
    const first = participants.split(',')[0].trim();
    const angleMatch = first.match(/<([^>]+)>/);
    return angleMatch ? angleMatch[1].trim() : first;
  }

  /** True when the active folder is Sent (show "To: …" instead of sender). */
  isSentFolder(): boolean {
    const folder = this.activeFolderId();
    if (!folder) {
      return false;
    }
    const normalized = folder.toLowerCase();
    return SENT_FOLDER_IDS.some((id) => id.toLowerCase() === normalized);
  }

  /** First recipient from toParticipants (for Sent folder). Parses "Name <email>" or plain email. */
  getToRecipientDisplay(): string {
    const toParticipants = this.thread().toParticipants;
    if (!toParticipants || !toParticipants.trim()) {
      return '(no recipient)';
    }
    const first = toParticipants.split(',')[0].trim();
    const nameMatch = first.match(/^(.+?)(?:\s*<.*>)?$/);
    return nameMatch?.[1]?.trim() || first || '(no recipient)';
  }

  getToRecipientEmail(): string | null {
    const toParticipants = this.thread().toParticipants;
    if (!toParticipants || !toParticipants.trim()) {
      return null;
    }
    const first = toParticipants.split(',')[0].trim();
    const angleMatch = first.match(/<([^>]+)>/);
    return angleMatch ? angleMatch[1].trim() : first;
  }

  getToRecipientName(): string {
    return this.getToRecipientDisplay();
  }

  getInitial(): string {
    const name = this.getSenderName();
    return name.charAt(0).toUpperCase();
  }

  onClick(event: MouseEvent): void {
    this.clicked.emit({
      thread: this.thread(),
      ctrlKey: event.ctrlKey || event.metaKey,
      shiftKey: event.shiftKey,
    });
  }

  onStarClick(event: Event): void {
    event.stopPropagation();
    this.starToggled.emit(this.thread());
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuRequested.emit({
      thread: this.thread(),
      x: event.clientX,
      y: event.clientY,
    });
  }
}
