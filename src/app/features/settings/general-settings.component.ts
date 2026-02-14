import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatRadioModule } from '@angular/material/radio';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { ThemeService, ThemeMode } from '../../core/services/theme.service';
import { UiStore } from '../../store/ui.store';
import { SettingsStore } from '../../store/settings.store';
import { LayoutMode, DensityMode } from '../../core/services/layout.service';

@Component({
  selector: 'app-general-settings',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    MatRadioModule, MatSlideToggleModule,
    MatSelectModule, MatFormFieldModule,
  ],
  template: `
    <h2>General Settings</h2>

    <section class="settings-section">
      <h3>Theme</h3>
      <mat-radio-group [value]="themeService.theme()" (change)="onThemeChange($event.value)">
        <mat-radio-button value="light">Light</mat-radio-button>
        <mat-radio-button value="dark">Dark</mat-radio-button>
        <mat-radio-button value="system">System</mat-radio-button>
      </mat-radio-group>
    </section>

    <section class="settings-section">
      <h3>Layout</h3>
      <mat-radio-group [value]="uiStore.layout()" (change)="onLayoutChange($event.value)">
        <mat-radio-button value="three-column">Three-column</mat-radio-button>
        <mat-radio-button value="bottom-preview">Bottom preview</mat-radio-button>
        <mat-radio-button value="list-only">List only</mat-radio-button>
      </mat-radio-group>
    </section>

    <section class="settings-section">
      <h3>Density</h3>
      <mat-radio-group [value]="uiStore.density()" (change)="onDensityChange($event.value)">
        <mat-radio-button value="compact">Compact (44px)</mat-radio-button>
        <mat-radio-button value="comfortable">Comfortable (56px)</mat-radio-button>
        <mat-radio-button value="spacious">Spacious (72px)</mat-radio-button>
      </mat-radio-group>
    </section>

    <section class="settings-section">
      <h3>Sidebar</h3>
      <div class="toggle-row">
        <mat-slide-toggle
          [checked]="settingsStore.showUnreadCounts()"
          (change)="settingsStore.toggleSetting('showUnreadCounts')"
        >Show unread counts</mat-slide-toggle>
      </div>
    </section>

    <section class="settings-section">
      <h3>Sync</h3>
      <div class="select-row">
        <label>Sync interval:</label>
        <mat-form-field appearance="outline" class="sync-select">
          <mat-select [value]="settingsStore.syncInterval()" (selectionChange)="settingsStore.setSyncInterval($event.value)">
            <mat-option [value]="1">Every 1 minute</mat-option>
            <mat-option [value]="2">Every 2 minutes</mat-option>
            <mat-option [value]="5">Every 5 minutes</mat-option>
            <mat-option [value]="10">Every 10 minutes</mat-option>
            <mat-option [value]="15">Every 15 minutes</mat-option>
            <mat-option [value]="30">Every 30 minutes</mat-option>
          </mat-select>
        </mat-form-field>
      </div>
      <div class="toggle-row">
        <mat-slide-toggle
          [checked]="settingsStore.syncOnStartup()"
          (change)="settingsStore.toggleSetting('syncOnStartup')"
        >Sync on startup</mat-slide-toggle>
      </div>
      <div class="toggle-row">
        <mat-slide-toggle
          [checked]="settingsStore.desktopNotifications()"
          (change)="settingsStore.toggleSetting('desktopNotifications')"
        >Desktop notifications for new mail</mat-slide-toggle>
      </div>
    </section>

    <section class="settings-section">
      <h3>Privacy</h3>
      <div class="toggle-row">
        <mat-slide-toggle
          [checked]="settingsStore.blockRemoteImages()"
          (change)="settingsStore.toggleSetting('blockRemoteImages')"
        >Block remote images by default</mat-slide-toggle>
      </div>
      <div class="toggle-row">
        <mat-slide-toggle
          [checked]="settingsStore.showAvatars()"
          (change)="settingsStore.toggleSetting('showAvatars')"
        >Show sender avatars</mat-slide-toggle>
      </div>
    </section>
  `,
  styles: [`
    h2 {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 24px 0;
      color: var(--color-text-primary);
    }

    .settings-section {
      margin-bottom: 28px;

      h3 {
        font-size: 14px;
        font-weight: 600;
        margin: 0 0 12px 0;
        color: var(--color-text-primary);
      }
    }

    mat-radio-group {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }

    .toggle-row {
      margin-bottom: 12px;
    }

    .select-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;

      label {
        font-size: 14px;
        color: var(--color-text-primary);
        white-space: nowrap;
      }
    }

    .sync-select {
      width: 200px;
    }
  `]
})
export class GeneralSettingsComponent implements OnInit {
  readonly themeService = inject(ThemeService);
  readonly uiStore = inject(UiStore);
  readonly settingsStore = inject(SettingsStore);

  ngOnInit(): void {
    this.settingsStore.loadSettings();
  }

  onThemeChange(mode: ThemeMode): void {
    this.themeService.setTheme(mode);
    this.settingsStore.setTheme(mode);
  }

  onLayoutChange(mode: LayoutMode): void {
    this.uiStore.setLayout(mode);
    this.settingsStore.setLayout(mode);
  }

  onDensityChange(mode: DensityMode): void {
    this.uiStore.setDensity(mode);
    this.settingsStore.setDensity(mode);
  }
}
