import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  computed,
  effect,
  OnInit,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LABEL_PRESET_COLORS, LabelColor } from '../../constants/label-colors';
import { hexToHsv, hsvToHex, normalizeHex, isValidHex } from '../../utils/color.util';

@Component({
  selector: 'app-color-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './color-picker.component.html',
  styleUrl: './color-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColorPickerComponent implements OnInit {
  private readonly elementRef = inject(ElementRef);

  /** Initial color (#RRGGBB or null for "no color"). */
  readonly selectedColor = input<string | null>(null);
  /** Optional override for the preset swatch list. */
  readonly paletteColors = input<LabelColor[]>(LABEL_PRESET_COLORS);
  /** When false, swatch/no-color and drag do not emit colorCommitted; parent uses Apply or backdrop to commit. */
  readonly commitOnSelect = input<boolean>(true);

  /** Emits the committed hex color (#RRGGBB) or null (when user explicitly applies, e.g. Apply button). */
  readonly colorCommitted = output<string | null>();
  /** Emits on every color change (swatch, no-color, drag end, hex blur) so parent can track pending value. */
  readonly colorChanged = output<string | null>();

  /** References to draggable elements */
  private readonly sbSquareRef = viewChild<ElementRef<HTMLElement>>('sbSquare');
  private readonly hueSliderRef = viewChild<ElementRef<HTMLElement>>('hueSlider');

  // ---- Internal HSV state ----
  readonly hue = signal(0);
  readonly saturation = signal(1);
  readonly brightness = signal(1);

  /** Whether the SB square cursor is being dragged. */
  private isDraggingSb = false;
  /** Whether the hue slider handle is being dragged. */
  private isDraggingHue = false;

  /** The live preview hex (updated on every drag frame). */
  readonly liveHex = computed(() => hsvToHex(this.hue(), this.saturation(), this.brightness()));

  /** The committed color (matches liveHex only after drag ends or swatch/input commit). */
  readonly committedColor = signal<string | null>(null);

  /** The hex input field value (string as the user types). */
  readonly hexInputValue = signal('');
  /** Whether the hex input is in an error state. */
  readonly hexInputError = signal(false);

  /** Whether "no color" swatch is selected. */
  readonly noColorSelected = computed(() => this.committedColor() === null);

  /** Cursor position as percentage (0–100) within the SB square. */
  readonly cursorLeft = computed(() => this.saturation() * 100);
  readonly cursorTop = computed(() => (1 - this.brightness()) * 100);

  /** Hue slider handle position as percentage (0–100). */
  readonly hueHandleTop = computed(() => (this.hue() / 360) * 100);

  /** SB square background gradient hue color (pure hue at full saturation/brightness). */
  readonly sbSquareHueColor = computed(() => hsvToHex(this.hue(), 1, 1));

  constructor() {
    // React to selectedColor input changes (e.g. when popover opens for a different label).
    // allowSignalWrites is required because we write to component signals inside this effect.
    effect(() => {
      const incoming = this.selectedColor();
      this.committedColor.set(incoming);
      if (incoming) {
        this.applyHexToState(incoming);
        this.hexInputValue.set(incoming.slice(1));
      } else {
        this.hexInputValue.set('');
      }
    }, { allowSignalWrites: true });
  }

  ngOnInit(): void {
    // Initial state is handled by the effect above; nothing extra needed here.
  }

  private applyHexToState(hex: string): void {
    const normalized = normalizeHex(hex);
    if (!normalized) {
      return;
    }
    const hsv = hexToHsv(normalized);
    if (hsv) {
      this.hue.set(hsv.hue);
      this.saturation.set(hsv.saturation);
      this.brightness.set(hsv.value);
    }
  }

  // ---- SB Square pointer events ----

  onSbPointerDown(event: PointerEvent): void {
    event.preventDefault();
    this.isDraggingSb = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.updateSbFromPointer(event);
  }

  onSbPointerMove(event: PointerEvent): void {
    if (!this.isDraggingSb) {
      return;
    }
    event.preventDefault();
    this.updateSbFromPointer(event);
  }

  onSbPointerUp(event: PointerEvent): void {
    if (!this.isDraggingSb) {
      return;
    }
    this.isDraggingSb = false;
    this.updateSbFromPointer(event);
    this.notifyColorChange();
  }

  private updateSbFromPointer(event: PointerEvent): void {
    const sbSquareEl = this.sbSquareRef()?.nativeElement;
    if (!sbSquareEl) {
      return;
    }
    const rect = sbSquareEl.getBoundingClientRect();
    const normalizedX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const normalizedY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    this.saturation.set(normalizedX);
    this.brightness.set(1 - normalizedY);
    this.hexInputValue.set(this.liveHex().slice(1));
    this.hexInputError.set(false);
  }

  /** Keyboard navigation on the SB square. */
  onSbKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 0.1 : 0.01;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        this.saturation.set(Math.min(1, this.saturation() + step));
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.saturation.set(Math.max(0, this.saturation() - step));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.brightness.set(Math.min(1, this.brightness() + step));
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.brightness.set(Math.max(0, this.brightness() - step));
        break;
      default:
        return;
    }
    this.hexInputValue.set(this.liveHex().slice(1));
    this.hexInputError.set(false);
    this.notifyColorChange();
  }

  // ---- Hue slider pointer events ----

  onHuePointerDown(event: PointerEvent): void {
    event.preventDefault();
    this.isDraggingHue = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.updateHueFromPointer(event);
  }

  onHuePointerMove(event: PointerEvent): void {
    if (!this.isDraggingHue) {
      return;
    }
    event.preventDefault();
    this.updateHueFromPointer(event);
  }

  onHuePointerUp(event: PointerEvent): void {
    if (!this.isDraggingHue) {
      return;
    }
    this.isDraggingHue = false;
    this.updateHueFromPointer(event);
    this.notifyColorChange();
  }

  private updateHueFromPointer(event: PointerEvent): void {
    const hueSliderEl = this.hueSliderRef()?.nativeElement;
    if (!hueSliderEl) {
      return;
    }
    const rect = hueSliderEl.getBoundingClientRect();
    const normalizedY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    this.hue.set(normalizedY * 360);
    this.hexInputValue.set(this.liveHex().slice(1));
    this.hexInputError.set(false);
  }

  /** Keyboard navigation on the hue slider. */
  onHueKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        this.hue.set(Math.max(0, this.hue() - step));
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.hue.set(Math.min(360, this.hue() + step));
        break;
      default:
        return;
    }
    this.hexInputValue.set(this.liveHex().slice(1));
    this.hexInputError.set(false);
    this.notifyColorChange();
  }

  // ---- Hex input ----

  onHexInput(value: string): void {
    this.hexInputValue.set(value);
    this.hexInputError.set(false);
    // Live-update the picker if the value is valid
    const candidate = value.startsWith('#') ? value : `#${value}`;
    if (isValidHex(candidate)) {
      this.applyHexToState(candidate);
    }
  }

  onHexBlur(): void {
    const candidate = this.hexInputValue().startsWith('#')
      ? this.hexInputValue()
      : `#${this.hexInputValue()}`;
    const normalized = normalizeHex(candidate);
    if (normalized) {
      this.hexInputError.set(false);
      this.hexInputValue.set(normalized.slice(1));
      this.applyHexToState(normalized);
      this.committedColor.set(normalized);
      this.colorChanged.emit(normalized);
      if (this.commitOnSelect()) {
        this.colorCommitted.emit(normalized);
      }
    } else {
      this.hexInputError.set(true);
    }
  }

  onHexKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      this.onHexBlur();
    } else if (event.key === 'Escape') {
      // Revert to last committed value
      const last = this.committedColor();
      this.hexInputValue.set(last ? last.slice(1) : '');
      this.hexInputError.set(false);
      if (last) {
        this.applyHexToState(last);
      }
    }
  }

  // ---- Swatch selection ----

  selectNoColor(): void {
    this.committedColor.set(null);
    this.hexInputValue.set('');
    this.hexInputError.set(false);
    this.colorChanged.emit(null);
    if (this.commitOnSelect()) {
      this.colorCommitted.emit(null);
    }
  }

  selectSwatch(color: LabelColor): void {
    const normalized = normalizeHex(color.hex);
    if (!normalized) {
      return;
    }
    this.applyHexToState(normalized);
    this.committedColor.set(normalized);
    this.hexInputValue.set(normalized.slice(1));
    this.hexInputError.set(false);
    this.colorChanged.emit(normalized);
    if (this.commitOnSelect()) {
      this.colorCommitted.emit(normalized);
    }
  }

  isSwatchSelected(hex: string): boolean {
    const normalized = normalizeHex(hex);
    return normalized !== null && normalized === this.committedColor();
  }

  // ---- Internal helpers ----

  /** Update committed state and emit colorChanged; emit colorCommitted only when commitOnSelect is true. */
  private notifyColorChange(): void {
    const hexValue = this.liveHex();
    this.committedColor.set(hexValue);
    this.colorChanged.emit(hexValue);
    if (this.commitOnSelect()) {
      this.colorCommitted.emit(hexValue);
    }
  }
}
