import { Component, input, signal, computed, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { getGravatarUrl } from '../../utils/gravatar.util';
import { ElectronService } from '../../../core/services/electron.service';

@Component({
  selector: 'app-sender-avatar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './sender-avatar.component.html',
  styleUrl: './sender-avatar.component.scss',
})
export class SenderAvatarComponent {
  private readonly electronService = inject(ElectronService);

  readonly email = input<string | null>(null);
  readonly displayName = input<string>('');
  readonly avatarClass = input<string>('sender-avatar');

  readonly gravatarFailed = signal(false);
  /** True only after we've confirmed the Gravatar image loads (avoids 404 console noise). */
  readonly gravatarAvailable = signal(false);

  private checkId = 0;

  readonly gravatarUrl = computed(() => {
    this.gravatarFailed();
    this.gravatarAvailable();
    return getGravatarUrl(this.email());
  });

  constructor() {
    effect(() => {
      const url = this.gravatarUrl();
      this.gravatarAvailable.set(false);
      this.gravatarFailed.set(false);
      if (!url) {
        return;
      }
      this.checkId += 1;
      const id = this.checkId;

      if (this.electronService.isElectron) {
        this.electronService.checkGravatar(url).then((result) => {
          if (id !== this.checkId) {
            return;
          }
          if (result.success && result.data?.available) {
            this.gravatarAvailable.set(true);
          } else {
            this.gravatarFailed.set(true);
          }
        });
      } else {
        const img = new Image();
        img.onload = () => {
          if (id === this.checkId) {
            this.gravatarAvailable.set(true);
          }
        };
        img.onerror = () => {
          if (id === this.checkId) {
            this.gravatarFailed.set(true);
          }
        };
        img.src = url;
      }
    });
  }

  readonly showInitial = computed(() => {
    const url = this.gravatarUrl();
    const available = this.gravatarAvailable();
    const failed = this.gravatarFailed();
    return !url || failed || !available;
  });

  readonly initial = computed(() => {
    const name = this.displayName().trim();
    if (!name) {
      return '?';
    }
    return name.charAt(0).toUpperCase();
  });
}
