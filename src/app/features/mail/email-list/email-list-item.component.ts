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
  styleUrl: './email-list-item.component.scss',
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
