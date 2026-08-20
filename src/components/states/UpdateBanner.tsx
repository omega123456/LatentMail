import { useAppUpdateQuery, useInstallUpdateMutation } from '@/lib/query/hooks';
import { useUpdateStore } from '@/stores/update';

export function UpdateBanner() {
  const { data } = useAppUpdateQuery();
  const dismissedVersion = useUpdateStore((state) => state.dismissedVersion);
  const dismiss = useUpdateStore((state) => state.dismiss);
  const installMutation = useInstallUpdateMutation();

  const available = data?.available;
  if (!available || available.version === dismissedVersion) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="update-banner"
      className="flex items-center justify-between gap-stack-gap-md bg-primary-container px-container-padding py-stack-gap-sm text-body-sm text-on-primary-container dark:bg-dark-primary-container dark:text-dark-on-primary-container"
    >
      <span>
        LatentMail {available.version} is available. You have {data.currentVersion}.
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => installMutation.mutate()}
          disabled={installMutation.isPending}
          className="cursor-pointer rounded-sm bg-primary px-3 py-1 text-on-primary disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary"
        >
          {installMutation.isPending ? 'Installing…' : 'Install and restart'}
        </button>
        <button
          onClick={() => dismiss(available.version)}
          className="cursor-pointer rounded-sm px-3 py-1 text-on-primary-container focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-primary-container"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
