import { Component, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../core/services/electron.service';

@Component({
  selector: 'app-titlebar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './titlebar.component.html',
  styleUrl: './titlebar.component.scss',
})
export class TitlebarComponent implements OnInit {
  isWindows = signal(false);
  maximized = signal(false);

  constructor(private electronService: ElectronService) {}

  async ngOnInit(): Promise<void> {
    const platform = await this.electronService.getPlatform();
    this.isWindows.set(platform === 'win32');
  }

  /* c8 ignore next -- Electron window API, would affect test harness */
  async onMinimize(): Promise<void> {
    await this.electronService.minimize();
  }

  /* c8 ignore next -- Electron window API, would affect test harness */
  async onMaximize(): Promise<void> {
    await this.electronService.maximize();
    this.maximized.set(await this.electronService.isMaximized());
  }

  /* c8 ignore next -- Electron window API, would affect test harness */
  async onClose(): Promise<void> {
    await this.electronService.closeWindow();
  }
}
