import { Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FoldersStore } from '../../../store/folders.store';
import { LabelManagerComponent } from './label-manager.component';

@Component({
  selector: 'app-folder-list',
  standalone: true,
  imports: [CommonModule, LabelManagerComponent],
  templateUrl: './folder-list.component.html',
  styleUrl: './folder-list.component.scss',
})
export class FolderListComponent {
  readonly foldersStore = inject(FoldersStore);
  readonly collapsed = input(false);
  readonly folderSelected = output<string>();
  readonly searchDismissed = output<void>();

  onFolderClick(folderId: string): void {
    // Clicking a real folder deactivates search
    if (this.foldersStore.searchActive()) {
      this.foldersStore.deactivateSearch();
    }
    this.foldersStore.setActiveFolder(folderId);
    this.folderSelected.emit(folderId);
  }

  onSearchFolderClick(): void {
    // No-op — search folder is already selected
  }

  onDismissSearch(event: Event): void {
    event.stopPropagation();
    this.searchDismissed.emit();
  }

  onLabelFolderSelected(folderId: string): void {
    this.folderSelected.emit(folderId);
  }
}
