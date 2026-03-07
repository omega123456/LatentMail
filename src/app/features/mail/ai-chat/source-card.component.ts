import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { DateTime } from 'luxon';
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
    const dt = DateTime.fromISO(isoDate);
    if (!dt.isValid) { return isoDate; }
    const isThisYear = dt.hasSame(DateTime.now(), 'year');
    return dt.toLocaleString(
      { month: 'short', day: 'numeric', ...(isThisYear ? {} : { year: 'numeric' }) },
      { locale: 'en-US' }
    );
  }
}
