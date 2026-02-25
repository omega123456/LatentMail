import { EmailAction, EmailActionContext } from './email-action.model';

/**
 * Sent folder IDs — used to determine visibility of the Follow-up action.
 */
const SENT_FOLDER_IDS = ['[Gmail]/Sent Mail', 'Sent', '[Gmail]/Sent'];

/**
 * Factory function that returns the standard ordered list of email actions.
 * Actions are grouped logically and rendered with separators between groups.
 */
export function getDefaultEmailActions(): EmailAction[] {
  return [
    // ─── Draft Group ───
    {
      id: 'edit-draft',
      icon: 'edit',
      label: 'Edit Draft',
      group: 'draft',
      cssClass: 'action-draft',
      isVisible: (ctx: EmailActionContext) => {
        // Both per-message and thread-level: show when isDraft is true.
        // For thread-level, isDraft reflects thread.hasDraft (any email in thread is a draft).
        // For per-message, isDraft reflects message.isDraft directly.
        return ctx.isDraft;
      },
      isEnabled: () => true,
    },

    // ─── Compose Group ───
    {
      id: 'reply',
      icon: 'reply',
      label: 'Reply',
      group: 'compose',
      isVisible: () => true,
      isEnabled: () => true,
    },
    {
      id: 'reply-all',
      icon: 'reply_all',
      label: 'Reply All',
      group: 'compose',
      isVisible: () => true,
      isEnabled: () => true,
    },
    {
      id: 'forward',
      icon: 'forward',
      label: 'Forward',
      group: 'compose',
      isVisible: () => true,
      isEnabled: () => true,
    },

    // ─── Manage Group ───
    {
      id: 'delete',
      icon: 'delete',
      label: 'Delete',
      group: 'manage',
      isVisible: (ctx: EmailActionContext) => ctx.activeFolderId !== '[Gmail]/Trash',
      isEnabled: () => true,
    },
    {
      id: 'move-to',
      icon: 'drive_file_move',
      label: 'Move to',
      group: 'manage',
      isVisible: () => true,
      isEnabled: () => true,
    },
    {
      id: 'labels',
      icon: 'label',
      label: 'Labels',
      group: 'manage',
      isVisible: () => true,
      isEnabled: () => true,
    },
    {
      id: 'mark-spam',
      icon: 'report',
      label: 'Mark as spam',
      group: 'manage',
      isVisible: (ctx: EmailActionContext) => ctx.activeFolderId !== '[Gmail]/Spam',
      isEnabled: () => true,
    },
    {
      id: 'mark-not-spam',
      icon: 'inbox',
      label: 'Not spam',
      group: 'manage',
      isVisible: (ctx: EmailActionContext) => ctx.activeFolderId === '[Gmail]/Spam',
      isEnabled: () => true,
    },

    // ─── State Group ───
    {
      id: 'star',
      icon: 'star_border',
      label: 'Star',
      activeIcon: 'star',
      activeLabel: 'Starred',
      group: 'state',
      isToggle: true,
      isActive: (ctx: EmailActionContext) => ctx.isStarred,
      isVisible: () => true,
      isEnabled: () => true,
    },
    {
      id: 'mark-read-unread',
      icon: 'mark_email_read',
      label: 'Read',
      activeIcon: 'mark_email_unread',
      activeLabel: 'Unread',
      group: 'state',
      isToggle: true,
      isActive: (ctx: EmailActionContext) => ctx.isRead,
      isVisible: () => true,
      isEnabled: () => true,
    },

    // ─── AI Group ───
    {
      id: 'summarize',
      icon: 'auto_awesome',
      label: 'Summarize',
      group: 'ai',
      cssClass: 'action-ai',
      isVisible: () => true,
      isEnabled: (ctx: EmailActionContext) => ctx.aiConnected && !ctx.summaryLoading,
      disabledTooltip: 'Ollama not connected',
    },
    {
      id: 'smart-reply',
      icon: 'quickreply',
      label: 'Smart Reply',
      group: 'ai',
      cssClass: 'action-ai',
      isVisible: () => true,
      isEnabled: (ctx: EmailActionContext) => ctx.aiConnected && !ctx.replyLoading,
      disabledTooltip: 'Ollama not connected',
    },
    {
      id: 'follow-up',
      icon: 'notifications_active',
      label: 'Follow-up',
      group: 'ai',
      cssClass: 'action-ai',
      isVisible: (ctx: EmailActionContext) =>
        SENT_FOLDER_IDS.includes(ctx.activeFolderId || ''),
      isEnabled: (ctx: EmailActionContext) => ctx.aiConnected && !ctx.followUpLoading,
      disabledTooltip: 'Ollama not connected',
    },
  ];
}
