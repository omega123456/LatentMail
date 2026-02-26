import { Email, Thread } from '../../../core/models/email.model';

/**
 * Logical groupings for email actions — used to insert visual separators between groups.
 */
export type EmailActionGroup = 'draft' | 'compose' | 'manage' | 'state' | 'ai';

/**
 * Runtime context passed to each action's visibility/enabled evaluator.
 * All properties needed for any predicate are included here — predicates are pure functions.
 */
export interface EmailActionContext {
  /** The specific email message (for per-message ribbons) or null (for thread-level). */
  message: Email | null;
  /** The current thread (always available when the reading pane is shown). */
  thread: Thread;
  /** The active folder identifier string. */
  activeFolderId: string | null;
  /** Whether Ollama AI is connected. */
  aiConnected: boolean;
  /** Whether the thread is starred. */
  isStarred: boolean;
  /** Whether the thread is read. */
  isRead: boolean;
  /** Whether the current message is a draft. */
  isDraft: boolean;
  /** Whether the AI summary is currently loading. */
  summaryLoading: boolean;
  /** Whether the AI reply suggestions are currently loading. */
  replyLoading: boolean;
  /** Whether the AI follow-up detection is currently loading. */
  followUpLoading: boolean;
  /**
   * The selected thread's current folder IDs (from thread.folders).
   * Used by the labels menu to pre-check which labels are already applied.
   */
  currentFolderIds?: string[];
  /**
   * The gmailLabelId of the account's trash folder (locale-aware, e.g. '[Gmail]/Trash' or '[Gmail]/Bin').
   * Used by the delete action visibility predicate.
   */
  trashFolderId: string;
}

/**
 * Represents a single action button in the ribbon.
 */
export interface EmailAction {
  /** Unique identifier for the action (e.g., 'reply', 'delete', 'star', 'move-to'). */
  id: string;
  /** Material icon name. For toggle actions, this is the default (false-state) icon. */
  icon: string;
  /** Display label. For toggle actions, this is the default (false-state) label. */
  label: string;
  /** Icon when toggle state is true (only for toggle actions like star, mark-read). */
  activeIcon?: string;
  /** Label when toggle state is true (only for toggle actions). */
  activeLabel?: string;
  /** Logical group for separator insertion. */
  group: EmailActionGroup;
  /** Whether this action is a toggle that depends on thread state. */
  isToggle?: boolean;
  /** For toggle actions, a function that returns whether the toggle is in the "active" state. */
  isActive?: (ctx: EmailActionContext) => boolean;
  /** Pure predicate: should this action be visible given the context? */
  isVisible: (ctx: EmailActionContext) => boolean;
  /** Pure predicate: should this action be enabled given the context? */
  isEnabled: (ctx: EmailActionContext) => boolean;
  /** Optional CSS class to apply to the action button. */
  cssClass?: string;
  /** Optional tooltip override (used when disabled). */
  disabledTooltip?: string;
}

/**
 * Event emitted when an action is triggered from the ribbon.
 */
export interface EmailActionEvent {
  /** Action identifier (e.g., 'reply', 'delete', 'star', 'move-to', 'reply-with:...'). */
  action: string;
  /** Optional Email reference — present when triggered from a per-message ribbon. */
  message?: Email;
  /** Optional target folder gmailLabelId — present only for 'move-to' action. */
  targetFolder?: string;
  /**
   * Array of gmailLabelId values for 'add-labels' and 'remove-labels' actions.
   */
  targetLabels?: string[];
}
