type PushPresentation = {
  generation: number;
  incoming: HTMLElement;
  outgoing: HTMLElement | null;
  animations: Animation[];
};

/** Owns every compositor resource used by the phone push transition. */
export class MobilePushPresentationController {
  private generation = 0;
  private presentation: PushPresentation | null = null;

  start(incoming: HTMLElement, outgoing: HTMLElement | null): void {
    this.cancel();
    const generation = ++this.generation;
    incoming.style.transform = 'translate3d(100%, 0, 0)';
    incoming.style.willChange = 'transform';
    if (outgoing) outgoing.style.willChange = 'transform';
    const options: KeyframeAnimationOptions = {
      duration: 420,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
      fill: 'forwards',
    };
    const animations = [
      incoming.animate(
        [{ transform: 'translate3d(100%, 0, 0)' }, { transform: 'translate3d(0%, 0, 0)' }],
        options,
      ),
      ...(outgoing
        ? [outgoing.animate(
            [{ transform: 'translate3d(0%, 0, 0)' }, { transform: 'translate3d(-8%, 0, 0)' }],
            options,
          )]
        : []),
    ];
    const presentation = { generation, incoming, outgoing, animations };
    this.presentation = presentation;
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => this.complete(presentation),
      () => this.complete(presentation),
    );
  }

  cancel(): void {
    this.generation += 1;
    const current = this.presentation;
    this.presentation = null;
    if (!current) return;
    current.animations.forEach((animation) => animation.cancel());
    this.clearStyles(current);
  }

  private complete(presentation: PushPresentation): void {
    if (this.presentation !== presentation || presentation.generation !== this.generation) return;
    this.presentation = null;
    presentation.animations.forEach((animation) => animation.cancel());
    this.clearStyles(presentation);
  }

  private clearStyles(presentation: PushPresentation): void {
    presentation.incoming.style.removeProperty('transform');
    presentation.incoming.style.removeProperty('will-change');
    presentation.outgoing?.style.removeProperty('transform');
    presentation.outgoing?.style.removeProperty('will-change');
  }
}
