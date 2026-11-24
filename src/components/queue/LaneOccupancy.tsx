function slotFillClass(isActive: boolean, muted: boolean): string {
  if (isActive) return 'bg-settings-primary dark:bg-dark-settings-primary';
  if (muted) return 'bg-settings-card-line dark:bg-dark-settings-card-line';
  return 'bg-settings-outline-variant dark:bg-dark-settings-outline-variant';
}

export function LaneOccupancy({
  capacity,
  active,
  muted,
}: {
  capacity: number;
  active: number;
  muted: boolean;
}) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-slot-gap">
      {Array.from({ length: capacity }, (_slot, index) => (
        <span
          key={index}
          data-testid="lane-slot"
          className={`size-1.5 rounded-full ${slotFillClass(index < active, muted)}`}
        />
      ))}
    </span>
  );
}
