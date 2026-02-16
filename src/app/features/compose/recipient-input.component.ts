import { Component, inject, input, output, signal, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../core/services/electron.service';
import { Contact } from '../../core/models/email.model';

@Component({
  selector: 'app-recipient-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './recipient-input.component.html',
  styles: [`
    :host {
      display: block;
      position: relative;
    }

    .recipient-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 12px;
      position: relative;
    }

    .recipient-label {
      font-size: 13px;
      color: var(--color-text-tertiary);
      padding-top: 6px;
      min-width: 32px;
    }

    .chips-input {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
      min-height: 32px;
      cursor: text;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      background-color: var(--color-primary-light);
      color: var(--color-primary);
      border-radius: 16px;
      padding: 2px 8px;
      font-size: 13px;
      max-width: 250px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chip-remove {
      display: flex;
      align-items: center;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      color: var(--color-primary);
      opacity: 0.7;

      &:hover { opacity: 1; }

      .material-symbols-outlined {
        font-size: 14px;
      }
    }

    .chip-text-input {
      flex: 1;
      min-width: 100px;
      border: none;
      outline: none;
      font-size: 14px;
      font-family: inherit;
      background: transparent;
      color: var(--color-text-primary);
      padding: 4px 0;
    }

    .suggestions-dropdown {
      position: absolute;
      top: 100%;
      left: 40px;
      right: 12px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 100;
      max-height: 200px;
      overflow-y: auto;
    }

    .suggestion-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 12px;
      border: none;
      background: none;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      color: var(--color-text-primary);

      &:hover, &.active {
        background-color: var(--color-primary-light);
      }
    }

    .suggestion-name {
      font-size: 13px;
      font-weight: 500;
    }

    .suggestion-email {
      font-size: 12px;
      color: var(--color-text-tertiary);
    }
  `]
})
export class RecipientInputComponent implements OnDestroy {
  readonly label = input<string>('To');
  readonly placeholder = input<string>('Recipients');
  readonly value = input<string>('');
  readonly valueChange = output<string>();

  private readonly electronService = inject(ElectronService);
  @ViewChild('inputEl') inputEl?: ElementRef<HTMLInputElement>;

  inputValue = '';
  showSuggestions = false;
  activeSuggestion = 0;
  suggestions = signal<Contact[]>([]);
  chips = signal<string[]>([]);
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void {
    if (this.searchTimeout) clearTimeout(this.searchTimeout);
  }

  ngOnInit(): void {
    this.parseValue(this.value());
  }

  ngOnChanges(): void {
    this.parseValue(this.value());
  }

  private parseValue(val: string): void {
    if (!val) {
      this.chips.set([]);
      return;
    }
    const parsed = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
    this.chips.set(parsed);
  }

  focusInput(): void {
    this.inputEl?.nativeElement?.focus();
  }

  onInput(): void {
    const query = this.inputValue.trim();
    this.activeSuggestion = 0;

    if (this.searchTimeout) clearTimeout(this.searchTimeout);

    if (query.length >= 2) {
      this.searchTimeout = setTimeout(async () => {
        try {
          const response = await this.electronService.searchContacts(query);
          if (response.success && response.data) {
            this.suggestions.set(response.data as Contact[]);
          }
        } catch {
          this.suggestions.set([]);
        }
      }, 200);
    } else {
      this.suggestions.set([]);
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
      event.preventDefault();
      if (this.suggestions().length > 0 && this.showSuggestions) {
        this.selectSuggestion(this.suggestions()[this.activeSuggestion]);
      } else if (this.inputValue.trim()) {
        this.addChip(this.inputValue.trim());
      }
    } else if (event.key === 'Backspace' && !this.inputValue && this.chips().length > 0) {
      this.removeChip(this.chips().length - 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeSuggestion = Math.min(this.activeSuggestion + 1, this.suggestions().length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeSuggestion = Math.max(this.activeSuggestion - 1, 0);
    } else if (event.key === 'Escape') {
      this.showSuggestions = false;
    }
  }

  onBlur(): void {
    // Delay to allow click on suggestion
    setTimeout(() => {
      if (this.inputValue.trim()) {
        this.addChip(this.inputValue.trim());
      }
      this.showSuggestions = false;
    }, 200);
  }

  selectSuggestion(contact: Contact): void {
    const value = contact.displayName
      ? `${contact.displayName} <${contact.email}>`
      : contact.email;
    this.addChip(value);
    this.showSuggestions = false;
  }

  addChip(value: string): void {
    const cleaned = value.replace(/,$/, '').trim();
    if (!cleaned) return;
    const current = this.chips();
    if (!current.includes(cleaned)) {
      this.chips.set([...current, cleaned]);
      this.emitValue();
    }
    this.inputValue = '';
    this.suggestions.set([]);
  }

  removeChip(index: number): void {
    const current = [...this.chips()];
    current.splice(index, 1);
    this.chips.set(current);
    this.emitValue();
  }

  private emitValue(): void {
    this.valueChange.emit(this.chips().join(', '));
  }
}
