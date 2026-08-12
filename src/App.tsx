import { QueryProvider } from '@/providers/QueryProvider';
import { LayoutProvider } from '@/providers/LayoutProvider';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { AppShell } from '@/components/shell/AppShell';
import { EventBridge } from '@/lib/query/event-bridge';

export default function App() {
  return (
    <QueryProvider>
      <EventBridge />
      <ThemeProvider>
        <LayoutProvider>
          <div className="min-h-screen bg-background font-inter text-on-surface dark:bg-dark-background dark:text-dark-on-surface">
            <AppShell />
          </div>
        </LayoutProvider>
      </ThemeProvider>
    </QueryProvider>
  );
}
