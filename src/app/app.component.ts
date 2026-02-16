import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TitlebarComponent } from './shared/components/titlebar.component';
import { ToastContainerComponent } from './shared/components/toast-container.component';
import { QueueStore } from './store/queue.store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TitlebarComponent, ToastContainerComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'MailClient';

  /** Injected so QueueStore is created at app startup and subscribes to queue:update for toasts. */
  private readonly queueStore = inject(QueueStore);
}
