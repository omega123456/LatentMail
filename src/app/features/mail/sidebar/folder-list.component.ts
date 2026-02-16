import { Component, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FoldersStore } from '../../../store/folders.store';

@Component({
  selector: 'app-folder-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './folder-list.component.html',
  styleUrl: './folder-list.component.scss',
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
