import { useEffect, type PropsWithChildren } from 'react';
import { useLayoutStore } from '@/stores/layout';

export function LayoutProvider({ children }: PropsWithChildren) {
  const hydrate = useLayoutStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return children;
}
