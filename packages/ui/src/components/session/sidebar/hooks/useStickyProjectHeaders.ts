import React from 'react';

type Args = {
  isDesktopShellRuntime: boolean;
  projectSections: unknown[];
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  /** When false, disconnect the observer and clear stuck state. */
  enabled?: boolean;
};

export const useStickyProjectHeaders = (args: Args): Set<string> => {
  const {
    isDesktopShellRuntime,
    projectSections,
    projectHeaderSentinelRefs,
    enabled = true,
  } = args;
  const [stuckProjectHeaders, setStuckProjectHeaders] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!enabled || !isDesktopShellRuntime) {
      setStuckProjectHeaders((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const projectId = (entry.target as HTMLElement).dataset.projectId;
          if (!projectId) {
            return;
          }

          setStuckProjectHeaders((prev) => {
            const next = new Set(prev);
            if (!entry.isIntersecting) {
              next.add(projectId);
            } else {
              next.delete(projectId);
            }
            return next;
          });
        });
      },
      { threshold: 0 },
    );

    projectHeaderSentinelRefs.current.forEach((el) => {
      if (el) {
        observer.observe(el);
      }
    });

    return () => observer.disconnect();
  }, [enabled, isDesktopShellRuntime, projectHeaderSentinelRefs, projectSections]);

  return stuckProjectHeaders;
};
