import { Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Thread } from '../../../core/models/email.model';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';
import { DensityMode } from '../../../core/services/layout.service';

interface FolderBadgeInfo {
  displayName: string;
  cssClass: string;
  icon: string;
  title: string;
}

const PRIMARY_SYSTEM_PRIORITY = [
  'INBOX',
  '[Gmail]/Sent Mail',
  '[Gmail]/Drafts',
  '[Gmail]/Starred',
  '[Gmail]/Important',
];

const SECONDARY_SYSTEM_PRIORITY = [
  '[Gmail]/All Mail',
  '[Gmail]/Trash',
  '[Gmail]/Spam',
];

const FOLDER_BADGE_META: Record<string, { displayName: string; cssClass: string; icon: string }> = {
  'inbox': { displayName: 'Inbox', cssClass: 'folder-badge--inbox', icon: 'inbox' },
  '[gmail]/sent mail': { displayName: 'Sent', cssClass: 'folder-badge--sent', icon: 'send' },
  '[gmail]/drafts': { displayName: 'Drafts', cssClass: 'folder-badge--drafts', icon: 'edit_note' },
  '[gmail]/trash': { displayName: 'Trash', cssClass: 'folder-badge--trash', icon: 'delete' },
  '[gmail]/spam': { displayName: 'Spam', cssClass: 'folder-badge--spam', icon: 'report' },
  '[gmail]/starred': { displayName: 'Starred', cssClass: 'folder-badge--starred', icon: 'star' },
  '[gmail]/important': { displayName: 'Important', cssClass: 'folder-badge--important', icon: 'label_important' },
  '[gmail]/all mail': { displayName: 'All Mail', cssClass: 'folder-badge--all-mail', icon: 'mail' },
};

const SYSTEM_FOLDER_KEYS = new Set(Object.keys(FOLDER_BADGE_META));

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
  readonly clicked = output<Thread>();
  readonly starToggled = output<Thread>();

  readonly labelBadge = computed(() => {
    const label = this.thread().label;
    if (!label) {
      return null;
    }
    return {
      name: label.name,
      color: label.color,
    };
  });

  readonly folderBadge = computed<FolderBadgeInfo | null>(() => {
    if (!this.showFolderBadge()) {
      return null;
    }

    const folders = this.thread().folders;
    if (!folders || folders.length === 0) {
      return null;
    }

    const selectedFolder = this.selectPriorityFolder(folders);
    if (!selectedFolder) {
      return null;
    }

    const normalized = selectedFolder.toLowerCase();
    const predefined = FOLDER_BADGE_META[normalized];
    if (predefined) {
      return {
        displayName: predefined.displayName,
        cssClass: predefined.cssClass,
        icon: predefined.icon,
        title: predefined.displayName,
      };
    }

    return {
      displayName: selectedFolder,
      cssClass: 'folder-badge--custom',
      icon: 'label',
      title: selectedFolder,
    };
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

  private selectPriorityFolder(folders: string[]): string | null {
    for (const folder of PRIMARY_SYSTEM_PRIORITY) {
      const matched = this.findFolderCaseInsensitive(folders, folder);
      if (matched) {
        return matched;
      }
    }

    const customFolders = folders
      .filter((folder) => !SYSTEM_FOLDER_KEYS.has(folder.toLowerCase()))
      .slice()
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    if (customFolders.length > 0) {
      return customFolders[0];
    }

    for (const folder of SECONDARY_SYSTEM_PRIORITY) {
      const matched = this.findFolderCaseInsensitive(folders, folder);
      if (matched) {
        return matched;
      }
    }

    return folders[0] || null;
  }

  private findFolderCaseInsensitive(folders: string[], target: string): string | null {
    const targetLower = target.toLowerCase();
    for (const folder of folders) {
      if (folder.toLowerCase() === targetLower) {
        return folder;
      }
    }
    return null;
  }
}
