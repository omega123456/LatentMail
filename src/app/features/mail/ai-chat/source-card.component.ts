import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { SourceEmail } from '../../../core/models/ai.model';

@Component({
  selector: 'app-source-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './source-card.component.html',
  styleUrl: './source-card.component.scss',
  imports: [],
})
export class SourceCardComponent {
  readonly source = input.required<SourceEmail>();
  /** When set, used for the citation badge instead of source.citationIndex (sequential display). */
  readonly displayIndex = input<number>();
  readonly sourceClicked = output<string>();  // emits xGmMsgId

  onClick(): void {
    this.sourceClicked.emit(this.source().xGmMsgId);
  }

  formatDate(isoDate: string): string {
    if (!isoDate) { return ''; }
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) { return isoDate; }
    const now = new Date();
    const isThisYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: isThisYear ? undefined : 'numeric',
    });
  }
}
