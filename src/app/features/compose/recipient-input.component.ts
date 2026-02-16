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
  styleUrl: './recipient-input.component.scss',
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
