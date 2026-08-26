import { QueryProvider } from '@/providers/QueryProvider';
import { LayoutProvider } from '@/providers/LayoutProvider';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { AppShell } from '@/components/shell/AppShell';
import { EventBridge } from '@/lib/query/event-bridge';
import { AssistantChatEvents } from '@/lib/ai/chat-events';

export default function App() {
  return (
    <QueryProvider>
      <EventBridge />
      <AssistantChatEvents />
      <ThemeProvider>
        <LayoutProvider>
          <div className="h-full bg-background font-inter text-on-surface dark:bg-dark-background dark:text-dark-on-surface">
            <AppShell />
          </div>
        </LayoutProvider>
      </ThemeProvider>
    </QueryProvider>
  );
}
