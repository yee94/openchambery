import React from 'react';

type MarkstreamFallbackBoundaryProps = {
  children: React.ReactNode;
  fallback: React.ReactNode;
};

type MarkstreamFallbackBoundaryState = {
  hasError: boolean;
};

export class MarkstreamFallbackBoundary extends React.Component<
  MarkstreamFallbackBoundaryProps,
  MarkstreamFallbackBoundaryState
> {
  state: MarkstreamFallbackBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MarkstreamFallbackBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    console.warn('[markstream-react] falling back to the current Markdown renderer', error);
  }

  render(): React.ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
