/**
 * Shared folder badge metadata and ordering for list items and reading pane.
 * Single source of truth for display names, CSS classes, and icons.
 */

export interface FolderBadgeInfo {
  displayName: string;
  cssClass: string;
  icon: string;
  title: string;
  /** Folder id (e.g. gmailLabelId) when this badge is for a custom/user label; used to look up color. */
  folderId?: string;
}

export const PRIMARY_SYSTEM_PRIORITY = [
  'INBOX',
  '[Gmail]/Sent Mail',
  '[Gmail]/Drafts',
  '[Gmail]/Starred',
  '[Gmail]/Important',
];

export const SECONDARY_SYSTEM_PRIORITY = [
  '[Gmail]/All Mail',
  '[Gmail]/Trash',
  '[Gmail]/Spam',
];

export const FOLDER_BADGE_META: Record<string, { displayName: string; cssClass: string; icon: string }> = {
  'inbox': { displayName: 'Inbox', cssClass: 'folder-badge--inbox', icon: 'inbox' },
  '[gmail]/sent mail': { displayName: 'Sent', cssClass: 'folder-badge--sent', icon: 'send' },
  '[gmail]/drafts': { displayName: 'Drafts', cssClass: 'folder-badge--drafts', icon: 'edit_note' },
  '[gmail]/trash': { displayName: 'Trash', cssClass: 'folder-badge--trash', icon: 'delete' },
  '[gmail]/spam': { displayName: 'Spam', cssClass: 'folder-badge--spam', icon: 'report' },
  '[gmail]/starred': { displayName: 'Starred', cssClass: 'folder-badge--starred', icon: 'star' },
  '[gmail]/important': { displayName: 'Important', cssClass: 'folder-badge--important', icon: 'label_important' },
  '[gmail]/all mail': { displayName: 'All Mail', cssClass: 'folder-badge--all-mail', icon: 'mail' },
};

export const SYSTEM_FOLDER_KEYS = new Set(Object.keys(FOLDER_BADGE_META));

export interface FolderForLookup {
  gmailLabelId: string;
  name: string;
}

/**
 * Order folder ids: primary system first, then custom (alphabetically), then secondary system.
 */
function orderFolderIds(folderIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const id of PRIMARY_SYSTEM_PRIORITY) {
    const matched = findFolderCaseInsensitive(folderIds, id);
    if (matched && !seen.has(matched.toLowerCase())) {
      seen.add(matched.toLowerCase());
      result.push(matched);
    }
  }

  const custom = folderIds
    .filter((f) => !SYSTEM_FOLDER_KEYS.has(f.toLowerCase()))
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const f of custom) {
    if (!seen.has(f.toLowerCase())) {
      seen.add(f.toLowerCase());
      result.push(f);
    }
  }

  for (const id of SECONDARY_SYSTEM_PRIORITY) {
    const matched = findFolderCaseInsensitive(folderIds, id);
    if (matched && !seen.has(matched.toLowerCase())) {
      seen.add(matched.toLowerCase());
      result.push(matched);
    }
  }

  return result;
}

function findFolderCaseInsensitive(folders: string[], target: string): string | null {
  const targetLower = target.toLowerCase();
  for (const folder of folders) {
    if (folder.toLowerCase() === targetLower) {
      return folder;
    }
  }
  return null;
}

/**
 * Returns badge info for a single folder id (system or custom).
 */
export function getBadgeForFolderId(
  folderId: string,
  nameLookup?: FolderForLookup[]
): FolderBadgeInfo {
  const normalized = folderId.toLowerCase();
  const predefined = FOLDER_BADGE_META[normalized];
  if (predefined) {
    return {
      displayName: predefined.displayName,
      cssClass: predefined.cssClass,
      icon: predefined.icon,
      title: predefined.displayName,
    };
  }
  const displayName =
    nameLookup?.find((f) => f.gmailLabelId.toLowerCase() === normalized)?.name ?? folderId;
  return {
    displayName,
    cssClass: 'folder-badge--custom',
    icon: 'label',
    title: displayName,
    folderId,
  };
}

/**
 * Returns an ordered array of folder badge info for the given folder ids.
 * Used by the reading pane to show all folder labels per message.
 */
export function getOrderedFolderBadges(
  folderIds: string[],
  nameLookup?: FolderForLookup[]
): FolderBadgeInfo[] {
  if (!folderIds || folderIds.length === 0) {
    return [];
  }
  const ordered = orderFolderIds(folderIds);
  return ordered.map((id) => getBadgeForFolderId(id, nameLookup));
}
