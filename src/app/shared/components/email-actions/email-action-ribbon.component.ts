import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  computed,
  HostBinding,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { EmailAction, EmailActionContext, EmailActionEvent } from './email-action.model';
import { getDefaultEmailActions } from './email-action-defaults';
import { MoveToMenuComponent } from '../move-to-menu/move-to-menu.component';
import { LabelsMenuComponent } from '../labels-menu/labels-menu.component';
import { Folder } from '../../../core/models/account.model';

/**
 * Reusable, data-driven action ribbon component.
 * Renders a horizontal row of action buttons from a provided configuration.
 * Supports 'standard' (thread-level toolbar) and 'compact' (per-message) variants.
 */
@Component({
  selector: 'app-email-action-ribbon',
  standalone: true,
  imports: [CommonModule, MoveToMenuComponent, LabelsMenuComponent],
  templateUrl: './email-action-ribbon.component.html',
  styleUrl: './email-action-ribbon.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmailActionRibbonComponent {
  /** The list of action definitions to render (defaults to the standard set). */
  readonly actions = input<EmailAction[]>(getDefaultEmailActions());
  /** The runtime context for visibility/enabled evaluation. */
  readonly context = input.required<EmailActionContext>();
  /** Visual variant: 'standard' for thread-level, 'compact' for per-message. */
  readonly variant = input<'standard' | 'compact'>('standard');
  /** The full list of folders (needed for the Move To menu). */
  readonly folders = input<Folder[]>([]);
  /** Unique identifier for this ribbon instance (provided by reading pane). */
  readonly ribbonId = input.required<string>();
  /** The currently open menu key from the thread-level shared state (null = none open). */
  readonly openMenuId = input<string | null>(null);

  /** Notifies parent when a menu opens (emits the unique key) or closes (emits null). */
  readonly openMenuChanged = output<string | null>();

  /** Emits when an action is triggered. */
  readonly actionTriggered = output<EmailActionEvent>();

  /** Apply variant class to the host element. */
  @HostBinding('class')
  get hostClass(): string {
    return `ribbon-${this.variant()}`;
  }

  /** Visible actions: only those whose visibility predicate returns true. */
  readonly visibleActions = computed(() => {
    const ctx = this.context();
    return this.actions().filter(a => a.isVisible(ctx));
  });

  /** Get the resolved icon for an action (handles toggle state). */
  getIcon(action: EmailAction): string {
    if (action.isToggle && action.isActive && action.activeIcon) {
      const ctx = this.context();
      return action.isActive(ctx) ? action.activeIcon : action.icon;
    }
    return action.icon;
  }

  /** Get the resolved label for an action (handles toggle state). */
  getLabel(action: EmailAction): string {
    if (action.isToggle && action.isActive && action.activeLabel) {
      const ctx = this.context();
      return action.isActive(ctx) ? action.activeLabel : action.label;
    }
    return action.label;
  }

  /** Whether the action is enabled in the current context. */
  isEnabled(action: EmailAction): boolean {
    return action.isEnabled(this.context());
  }

  /** Get tooltip for an action. */
  getTooltip(action: EmailAction): string {
    if (!this.isEnabled(action) && action.disabledTooltip) {
      return action.disabledTooltip;
    }
    return this.getLabel(action);
  }

  /** Get CSS class for an action button. */
  getActionClass(action: EmailAction): string {
    const classes = ['ribbon-btn'];
    if (action.cssClass) {
      classes.push(action.cssClass);
    }
    if (action.isToggle && action.isActive?.(this.context())) {
      classes.push('active');
    }
    return classes.join(' ');
  }

  /** Whether a separator should appear before this action (different group from previous visible action). */
  shouldShowSeparator(index: number): boolean {
    if (index === 0) {
      return false;
    }
    const visible = this.visibleActions();
    return visible[index].group !== visible[index - 1].group;
  }

  /** Handle action button click. */
  onActionClick(action: EmailAction): void {
    if (!this.isEnabled(action)) {
      return;
    }
    const ctx = this.context();
    this.actionTriggered.emit({
      action: action.id,
      message: ctx.message ?? undefined,
    });
  }

  /** Handle folder selection from the Move To menu. */
  onMoveToFolderSelected(folderId: string): void {
    const ctx = this.context();
    this.actionTriggered.emit({
      action: 'move-to',
      message: ctx.message ?? undefined,
      targetFolder: folderId,
    });
  }

  /** Handle a label being checked (added) from the Labels menu. */
  onLabelAdded(gmailLabelId: string): void {
    const ctx = this.context();
    this.actionTriggered.emit({
      action: 'add-labels',
      message: ctx.message ?? undefined,
      targetLabels: [gmailLabelId],
    });
  }

  /** Handle a label being unchecked (removed) from the Labels menu. */
  onLabelRemoved(gmailLabelId: string): void {
    const ctx = this.context();
    this.actionTriggered.emit({
      action: 'remove-labels',
      message: ctx.message ?? undefined,
      targetLabels: [gmailLabelId],
    });
  }
}
