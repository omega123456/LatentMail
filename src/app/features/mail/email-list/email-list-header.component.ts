import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FoldersStore } from '../../../store/folders.store';
import { UiStore } from '../../../store/ui.store';
import { LayoutMode, DensityMode } from '../../../core/services/layout.service';

@Component({
  selector: 'app-email-list-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './email-list-header.component.html',
  styleUrl: './email-list-header.component.scss',
})
export class EmailListHeaderComponent {
  readonly foldersStore = inject(FoldersStore);
  readonly uiStore = inject(UiStore);

  densityIcon(): string {
    switch (this.uiStore.density()) {
      case 'compact': return 'density_small';
      case 'comfortable': return 'density_medium';
      case 'spacious': return 'density_large';
    }
  }

  layoutIcon(): string {
    switch (this.uiStore.layout()) {
      case 'three-column': return 'view_sidebar';
      case 'bottom-preview': return 'view_agenda';
      case 'list-only': return 'view_list';
    }
  }

  cycleDensity(): void {
    const modes: DensityMode[] = ['compact', 'comfortable', 'spacious'];
    const current = modes.indexOf(this.uiStore.density());
    this.uiStore.setDensity(modes[(current + 1) % modes.length]);
  }

  cycleLayout(): void {
    const modes: LayoutMode[] = ['three-column', 'bottom-preview', 'list-only'];
    const current = modes.indexOf(this.uiStore.layout());
    this.uiStore.setLayout(modes[(current + 1) % modes.length]);
  }
}
