export function QueueStateChip({
  pipClassName,
  label,
  className = '',
}: {
  pipClassName: string;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.75 whitespace-nowrap text-settings-meta ${className}`}
    >
      <span aria-hidden="true" className={`size-1.75 shrink-0 rounded-full ${pipClassName}`} />
      {label}
    </span>
  );
}
