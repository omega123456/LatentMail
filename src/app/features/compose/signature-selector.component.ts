import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ComposeStore, Signature } from '../../store/compose.store';

@Component({
  selector: 'app-signature-selector',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './signature-selector.component.html',
  styleUrl: './signature-selector.component.scss',
})
export class SignatureSelectorComponent {
  readonly composeStore = inject(ComposeStore);
  isOpen = false;

  toggleDropdown(): void {
    this.isOpen = !this.isOpen;
  }

  selectSignature(sig: Signature | null): void {
    this.composeStore.setActiveSignature(sig?.id || null);
    this.isOpen = false;
  }
}
