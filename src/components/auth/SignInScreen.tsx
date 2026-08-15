import { useState } from 'react';
import { Mail, LoaderCircle } from 'lucide-react';
import { invoke } from '@/lib/ipc/commands';
import { useToastStore } from '@/stores/toast';

export function SignInScreen() {
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showError = useToastStore((state) => state.showError);
  const signIn = async () => {
    setSigningIn(true);
    setError(null);
    try {
      await invoke('begin_sign_in', {});
    } catch (cause) {
      // `invoke` already logged the failure centrally; this only surfaces it.
      // The inline block keeps the detailed cause next to the button that
      // failed; the toast is what catches the eye of a user who has already
      // looked away waiting for the browser to open.
      setError(
        `Could not start Google sign-in: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      showError('Couldn’t start Google sign-in.');
      setSigningIn(false);
    }
  };
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-surface p-container-padding dark:bg-dark-surface"
      data-testid="sign-in-screen"
    >
      <section className="w-full max-w-md rounded-md bg-surface-container-lowest p-8 shadow-lg dark:bg-dark-surface-container-lowest">
        <div className="mb-8 flex items-center gap-stack-gap-sm text-primary dark:text-dark-primary">
          <Mail aria-hidden="true" />
          <span className="text-title-lg">LatentMail</span>
        </div>
        <h1 className="text-display-sm">Welcome to your inbox</h1>
        <p className="mt-stack-gap-sm text-body-md text-on-surface-variant dark:text-dark-on-surface-variant">
          A private, focused Gmail client for your desktop.
        </p>
        {error && (
          <div
            role="alert"
            className="mt-stack-gap-md flex items-center justify-between rounded bg-error-container p-stack-gap-sm text-body-sm text-on-error-container"
          >
            <span>{error}</span>
            <button
              aria-label="Dismiss sign-in error"
              className="rounded-sm px-2 focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        <button
          onClick={() => void signIn()}
          disabled={signingIn}
          className="mt-8 flex w-full items-center justify-center gap-stack-gap-sm rounded-md bg-primary px-4 py-3 text-body-md text-on-primary disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary"
        >
          {signingIn && <LoaderCircle className="animate-spin" aria-hidden="true" />}{' '}
          {signingIn ? 'Signing in…' : 'Continue with Google'}
        </button>
      </section>
    </main>
  );
}
