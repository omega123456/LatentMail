import { Tag, type LucideIcon } from 'lucide-react';
import { SYSTEM_BADGES, type MessageBadge } from '@/lib/labels/badges';
import { LABEL_COLOR_BY_ID, LABEL_COLOR_PALETTE } from '@/lib/labels/palette';

function BadgeShell({
  name,
  Icon,
  className,
  iconOnly,
}: {
  name: string;
  Icon: LucideIcon;
  className: string;
  iconOnly: boolean;
}) {
  return (
    <li
      title={name}
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-label-sm ${className}`}
    >
      <Icon aria-hidden="true" size={12} />
      <span className={iconOnly ? 'sr-only' : 'truncate'}>{name}</span>
    </li>
  );
}

export function Badge({ badge, iconOnly = false }: { badge: MessageBadge; iconOnly?: boolean }) {
  if (badge.kind === 'system') {
    const { name, Icon, className } = SYSTEM_BADGES[badge.id];
    return (
      <BadgeShell name={name} Icon={Icon} iconOnly={iconOnly} className={`py-0.5 ${className}`} />
    );
  }
  const swatch = LABEL_COLOR_BY_ID[badge.color] ?? LABEL_COLOR_PALETTE[0];
  return (
    <BadgeShell
      name={badge.name}
      Icon={Tag}
      iconOnly={iconOnly}
      className={`max-w-40 border py-px ${swatch.tintClass} ${swatch.borderClass} ${swatch.inkClass}`}
    />
  );
}
