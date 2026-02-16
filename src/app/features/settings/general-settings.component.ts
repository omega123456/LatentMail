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
  templateUrl: './general-settings.component.html',
  styleUrl: './general-settings.component.scss',
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
