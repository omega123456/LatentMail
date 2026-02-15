import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ComposeStore, Signature } from '../../store/compose.store';

@Component({
  selector: 'app-signature-selector',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="signature-selector" (click)="toggleDropdown()">
      <span class="material-symbols-outlined">draw</span>
      <span>{{ composeStore.activeSignature()?.name || 'Signature' }}</span>
      <span class="material-symbols-outlined arrow">expand_more</span>

      @if (isOpen) {
        <div class="dropdown" (click)="$event.stopPropagation()">
          <button class="dropdown-item" (click)="selectSignature(null)">
            <span>No signature</span>
            @if (!composeStore.activeSignatureId()) {
              <span class="material-symbols-outlined check">check</span>
            }
          </button>
          @for (sig of composeStore.signatures(); track sig.id) {
            <button class="dropdown-item" (click)="selectSignature(sig)">
              <span>{{ sig.name }}</span>
              @if (composeStore.activeSignatureId() === sig.id) {
                <span class="material-symbols-outlined check">check</span>
              }
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .signature-selector {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border: none;
      background: none;
      border-radius: 6px;
      cursor: pointer;
      color: var(--color-text-secondary);
      font-size: 13px;
      position: relative;

      &:hover {
        background-color: var(--color-surface-variant);
      }

      .material-symbols-outlined { font-size: 16px; }
      .arrow { font-size: 14px; }
    }

    .dropdown {
      position: absolute;
      bottom: 100%;
      left: 0;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      min-width: 180px;
      z-index: 100;
      overflow: hidden;
    }

    .dropdown-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 8px 12px;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
      color: var(--color-text-primary);
      text-align: left;

      &:hover {
        background-color: var(--color-primary-light);
      }

      .check {
        font-size: 16px;
        color: var(--color-primary);
      }
    }
  `]
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
