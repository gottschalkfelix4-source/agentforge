import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AppRouter } from '@/app/router';
import { createQueryClient, qk } from '@/lib/queries';
import { setUnauthorizedHandler } from '@/lib/api';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUi } from '@/lib/store';
import './styles.css';

const queryClient = createQueryClient();

// Any 401 from the API → re-check /api/me; the auth gate then redirects to /login.
setUnauthorizedHandler(() => {
  void queryClient.invalidateQueries({ queryKey: qk.me });
});

function ThemedToaster() {
  const theme = useUi((s) => s.theme);
  return <Toaster theme={theme} position="bottom-right" richColors closeButton />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <AppRouter />
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
