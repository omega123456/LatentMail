import { Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FoldersStore } from '../../../store/folders.store';

@Component({
  selector: 'app-folder-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <nav class="folder-list">
      @for (folder of foldersStore.systemFolders(); track folder.gmailLabelId) {
        <div
          class="folder-item"
          [class.active]="folder.gmailLabelId === foldersStore.activeFolderId()"
          [class.collapsed]="collapsed()"
          [title]="collapsed() ? folder.name : ''"
          (click)="onFolderClick(folder.gmailLabelId)"
        >
          <span class="material-symbols-outlined">{{ folder.icon || 'folder' }}</span>
          @if (!collapsed()) {
            <span class="folder-name">{{ folder.name }}</span>
            @if (folder.unreadCount > 0) {
              <span class="unread-count">{{ folder.unreadCount }}</span>
            }
          }
        </div>
      }

      @if (!collapsed() && foldersStore.userLabels().length > 0) {
        <div class="labels-header">Labels</div>
        @for (label of foldersStore.userLabels(); track label.gmailLabelId) {
          <div
            class="folder-item"
            [class.active]="label.gmailLabelId === foldersStore.activeFolderId()"
            (click)="onFolderClick(label.gmailLabelId)"
          >
            <span class="material-symbols-outlined">label</span>
            <span class="folder-name">{{ label.name }}</span>
            @if (label.unreadCount > 0) {
              <span class="unread-count">{{ label.unreadCount }}</span>
            }
          </div>
        }
      }
    </nav>
  `,
  styles: [`
    .folder-list {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .folder-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      cursor: pointer;
      color: var(--color-text-primary);
      transition: background-color 120ms ease;
      font-size: 14px;
      white-space: nowrap;

      &:hover {
        background-color: var(--color-primary-light);
      }

      &.active {
        background-color: var(--color-primary-light);
        color: var(--color-primary);
        font-weight: 500;
      }

      &.collapsed {
        justify-content: center;
        padding: 10px 0;
      }

      .material-symbols-outlined {
        font-size: 20px;
        flex-shrink: 0;
      }
    }

    .folder-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .unread-count {
      font-size: 12px;
      font-weight: 500;
      color: var(--color-accent);
      min-width: 20px;
      text-align: right;
    }

    .labels-header {
      padding: 12px 16px 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--color-text-tertiary);
      letter-spacing: 0.5px;
    }
  `]
})
export class FolderListComponent {
  readonly foldersStore = inject(FoldersStore);
  readonly collapsed = input(false);
  readonly folderSelected = output<string>();

  onFolderClick(folderId: string): void {
    this.foldersStore.setActiveFolder(folderId);
    this.folderSelected.emit(folderId);
  }
}
