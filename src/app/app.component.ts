import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TitlebarComponent } from './shared/components/titlebar.component';
import { ToastContainerComponent } from './shared/components/toast-container.component';
import { CommandPaletteComponent } from './features/command-palette/command-palette.component';
import { CommandRegistryService } from './core/services/command-registry.service';
import { QueueStore } from './store/queue.store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TitlebarComponent, ToastContainerComponent, CommandPaletteComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'MailClient';

  /** Injected so QueueStore is created at app startup and subscribes to queue:update for toasts. */
  private readonly queueStore = inject(QueueStore);

  /**
   * Injected so CommandRegistryService is created at app startup and registers
   * all default commands with KeyboardService.
   */
  private readonly commandRegistry = inject(CommandRegistryService);
}
