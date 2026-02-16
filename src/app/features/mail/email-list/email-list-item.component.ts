import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Thread } from '../../../core/models/email.model';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe';
import { DensityMode } from '../../../core/services/layout.service';

@Component({
  selector: 'app-email-list-item',
  standalone: true,
  imports: [CommonModule, RelativeTimePipe],
  templateUrl: './email-list-item.component.html',
  styles: [`
    :host {
      display: block;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }

    .email-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 16px;
      min-width: 0;
      cursor: pointer;
      border-bottom: 1px solid var(--color-border);
      transition: background-color 120ms ease;

      &:hover {
        background-color: var(--color-primary-light);
      }

      &.selected {
        background-color: var(--color-primary-light);
      }

      &.unread {
        background-color: rgba(25, 118, 210, 0.04);
      }

      &.compact {
        padding: 6px 16px;
        gap: 8px;
        align-items: center;

        .email-avatar {
          width: 28px;
          height: 28px;
          min-width: 28px;
          font-size: 11px;
        }

        .email-sender { font-size: 13px; }
        .email-subject { font-size: 12px; }
        .email-date { font-size: 11px; }
      }

      &.spacious {
        padding: 14px 16px;

        .email-avatar {
          width: 40px;
          height: 40px;
          min-width: 40px;
          font-size: 16px;
        }
      }
    }

    .email-avatar {
      width: 36px;
      height: 36px;
      min-width: 36px;
      border-radius: 50%;
      background-color: var(--color-primary);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 500;
      margin-top: 2px;
      flex-shrink: 0;
    }

    .email-content {
      flex: 1;
      min-width: 0;
      width: 0;
      overflow: hidden;
    }

    .email-top-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
    }

    .email-sender {
      flex: 1;
      min-width: 0;
      font-size: 14px;
      color: var(--color-text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      &.bold {
        font-weight: 600;
      }
    }

    .email-date {
      flex-shrink: 0;
      font-size: 12px;
      color: var(--color-text-tertiary);
      white-space: nowrap;
    }

    .email-subject {
      display: block;
      min-width: 0;
      max-width: 100%;
      font-size: 13px;
      color: var(--color-text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;

      &.bold {
        font-weight: 500;
      }
    }

    .email-snippet {
      display: block;
      min-width: 0;
      max-width: 100%;
      font-size: 12px;
      color: var(--color-text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }

    .email-indicators {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      min-width: 24px;
    }

    .star-icon {
      font-size: 18px;
      color: var(--color-text-tertiary);
      cursor: pointer;
      transition: color 200ms ease;

      &:hover {
        color: var(--color-accent);
      }

      &.starred {
        color: var(--color-accent);
        font-variation-settings: 'FILL' 1;
      }
    }

    .message-count {
      font-size: 11px;
      color: var(--color-text-tertiary);
      background-color: var(--color-surface-variant);
      border-radius: 8px;
      padding: 1px 6px;
    }
  `]
})
export class EmailListItemComponent {
  readonly thread = input.required<Thread>();
  readonly isSelected = input<boolean>(false);
  readonly density = input<DensityMode>('comfortable');
  readonly clicked = output<Thread>();
  readonly starToggled = output<Thread>();

  getSenderName(): string {
    const participants = this.thread().participants;
    if (participants) {
      const first = participants.split(',')[0].trim();
      const nameMatch = first.match(/^(.+?)(?:\s*<.*>)?$/);
      return nameMatch?.[1] || first;
    }
    return 'Unknown';
  }

  getInitial(): string {
    const name = this.getSenderName();
    return name.charAt(0).toUpperCase();
  }

  onStarClick(event: Event): void {
    event.stopPropagation();
    this.starToggled.emit(this.thread());
  }
}
