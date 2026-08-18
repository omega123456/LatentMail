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
      {Array.from({ length: capacity }, (_, index) => (
        <span
          key={index}
          data-testid="lane-slot"
          className={`size-1.5 rounded-full ${
            index < active
              ? 'bg-settings-primary dark:bg-dark-settings-primary'
              : muted
                ? 'bg-settings-card-line dark:bg-dark-settings-card-line'
                : 'bg-settings-outline-variant dark:bg-dark-settings-outline-variant'
          }`}
        />
      ))}
    </span>
  );
}
