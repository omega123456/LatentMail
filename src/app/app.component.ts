import { Component, HostBinding, inject, OnDestroy, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Subscription } from 'rxjs';
import { TitlebarComponent } from './shared/components/titlebar.component';
import { ToastContainerComponent } from './shared/components/toast-container.component';
import { ZoomIndicatorComponent } from './shared/components/zoom-indicator.component';
import { CommandPaletteComponent } from './features/command-palette/command-palette.component';
import { CommandRegistryService } from './core/services/command-registry.service';
import { ElectronService } from './core/services/electron.service';
import { QueueStore } from './store/queue.store';
import { SettingsStore } from './store/settings.store';
import { AccountsStore } from './store/accounts.store';
import { ComposeStore } from './store/compose.store';
import { EmailsStore } from './store/emails.store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TitlebarComponent, ToastContainerComponent, ZoomIndicatorComponent, CommandPaletteComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'LatentMail';

  /** Set when platform is darwin so we can reserve top padding for traffic lights. */
  @HostBinding('class.platform-darwin') platformDarwin = false;

  /** Injected so QueueStore is created at app startup and subscribes to queue:update for toasts. */
  private readonly queueStore = inject(QueueStore);

  /**
   * Injected so CommandRegistryService is created at app startup and registers
   * all default commands with KeyboardService.
   */
  private readonly commandRegistry = inject(CommandRegistryService);

  private readonly settingsStore = inject(SettingsStore);
  private readonly electronService = inject(ElectronService);
  private readonly accountsStore = inject(AccountsStore);
  private readonly composeStore = inject(ComposeStore);
  private readonly emailsStore = inject(EmailsStore);

  private trayActionSub: Subscription | null = null;

  ngOnInit(): void {
    this.settingsStore.loadSettings();
    this.subscribeToTrayActions();
    this.detectPlatform();
  }

  private async detectPlatform(): Promise<void> {
    /* c8 ignore next -- non-Electron */
    if (!this.electronService.isElectron) {
      return;
    }
    this.platformDarwin = await this.electronService.getIsMacOS();
  }

  ngOnDestroy(): void {
    /* c8 ignore start -- app component never destroyed in E2E */
    this.trayActionSub?.unsubscribe();
    this.trayActionSub = null;
    /* c8 ignore stop */
  }

  private subscribeToTrayActions(): void {
    /* c8 ignore next -- non-Electron */
    if (!this.electronService.isElectron) {
      return;
    }
    /* c8 ignore start -- requires tray event emission, no test hook */
    this.trayActionSub = this.electronService.onTrayAction().subscribe((payload) => {
      if (payload.action === 'compose') {
        const account = this.accountsStore.activeAccount();
        if (account) {
          this.composeStore.openCompose({
            mode: 'new',
            accountId: account.id,
            accountEmail: account.email,
            accountDisplayName: account.displayName,
          });
        }
      } else if (payload.action === 'sync') {
        const account = this.accountsStore.activeAccount();
        if (account) {
          void this.emailsStore.syncAccount(account.id);
        }
      }
    });
    /* c8 ignore stop */
  }
}
