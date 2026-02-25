import { Component, input, signal, computed, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
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
  private readonly sanitizer = inject(DomSanitizer);

  readonly email = input<string | null>(null);
  readonly displayName = input<string>('');
  readonly avatarClass = input<string>('sender-avatar');

  readonly bimiLogoUrl = signal<string | null>(null);

  /** Sanitized for img src so custom schemes (e.g. bimi-logo://) are allowed. */
  readonly sanitizedLogoUrl = computed(() => {
    const url = this.bimiLogoUrl();
    if (!url) {
      return null;
    }
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  });

  private requestId = 0;

  constructor() {
    effect(() => {
      const address = this.email();
      this.bimiLogoUrl.set(null);
      if (!address?.trim() || !this.electronService.isElectron) {
        return;
      }
      this.requestId += 1;
      const id = this.requestId;
      this.electronService.getBimiLogo(address).then((result) => {
        if (id !== this.requestId) {
          return;
        }
        if (result.success && result.data?.logoUrl) {
          this.bimiLogoUrl.set(result.data.logoUrl);
        }
      });
    });
  }

  readonly showInitial = computed(() => !this.bimiLogoUrl());

  readonly initial = computed(() => {
    const name = this.displayName().trim();
    if (!name) {
      return '?';
    }
    return name.charAt(0).toUpperCase();
  });
}
