import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ZoomService } from '../../core/services/zoom.service';

@Component({
  selector: 'app-zoom-indicator',
  standalone: true,
  templateUrl: './zoom-indicator.component.html',
  styleUrl: './zoom-indicator.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ZoomIndicatorComponent {
  readonly zoomService = inject(ZoomService);
}
