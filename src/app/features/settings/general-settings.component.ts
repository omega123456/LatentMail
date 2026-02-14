import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-general-settings',
  standalone: true,
  imports: [CommonModule],
  template: `
    <h2>General Settings</h2>
    <p class="placeholder">Theme, layout, density, and sync settings will be implemented in Phase 4.</p>
  `,
  styles: [`
    h2 {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 16px 0;
      color: var(--color-text-primary);
    }

    .placeholder {
      color: var(--color-text-tertiary);
      font-size: 14px;
    }
  `]
})
export class GeneralSettingsComponent {}
