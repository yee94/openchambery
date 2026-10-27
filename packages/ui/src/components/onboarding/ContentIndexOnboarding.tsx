import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { sessionContentIndexStatusOptions } from '@/queries/sessionContentSearchQueries';

const OnboardingScreen = lazyWithChunkRecovery(() =>
  import('./OnboardingScreen').then((module) => ({ default: module.OnboardingScreen })),
);

function StartupIndexCheck() {
  const [dismissed, setDismissed] = React.useState(false);
  const status = useQuery({
    ...sessionContentIndexStatusOptions(),
    enabled: !dismissed,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const index = query.state.data;
      if (index === null || (index && index.initializationRequired === undefined)) return false;
      return index?.initializationRequired === false && index.updatedAt != null ? false : 3000;
    },
  });
  const index = status.data;
  const finished = status.isFetchedAfterMount && !status.isError && (
    index === null || (index && (index.initializationRequired === undefined
      || (index.initializationRequired === false && index.updatedAt != null)))
  );

  React.useEffect(() => {
    if (finished) setDismissed(true);
  }, [finished]);

  if (dismissed || !index?.initializationRequired || index.total === 0) return null;
  return (
    <React.Suspense fallback={null}>
      <Dialog open onOpenChange={(open) => { if (!open) setDismissed(true); }}>
        <DialogContent showCloseButton={false} className="h-full max-w-none rounded-none border-0 p-0"
          style={{ transform: 'none', transition: 'none', opacity: 1 }}
          overlayClassName="z-[9997]" containerClassName="z-[9997] items-stretch p-0">
          <OnboardingScreen mode="content-index" indexStatus={index} indexStatusError={status.isError}
            onContinueInBackground={() => setDismissed(true)} />
        </DialogContent>
      </Dialog>
    </React.Suspense>
  );
}

export function ContentIndexOnboarding() {
  const isVSCode = useIsVSCodeRuntime();
  // The extension connects directly to OpenCode and has no Host-owned FTS service.
  if (isVSCode) return null;
  const scope = sessionContentIndexStatusOptions().queryKey;
  return <StartupIndexCheck key={JSON.stringify(scope)} />;
}
