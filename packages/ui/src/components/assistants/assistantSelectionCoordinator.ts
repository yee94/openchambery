export type AssistantSelection = { providerID?: string; modelID?: string; agent?: string; variant?: string };

export type AssistantSelectionIdentity = {
  assistantID: string;
  transportIdentity: string;
  runtimeGeneration: number;
};

export class AssistantSelectionStaleError extends Error {
  constructor() {
    super('assistant_selection_stale');
  }
}

type Waiter = { resolve: () => void; reject: (error: unknown) => void };
type Flight = { identity: AssistantSelectionIdentity; controller: AbortController; running: boolean; desired: AssistantSelection | null; waiters: Waiter[]; activeWaiters: Waiter[]; idleWaiters: Waiter[]; retired: boolean };

const sameIdentity = (left: AssistantSelectionIdentity, right: AssistantSelectionIdentity) => left.assistantID === right.assistantID && left.transportIdentity === right.transportIdentity && left.runtimeGeneration === right.runtimeGeneration;

export class AssistantSelectionCoordinator {
  private flight: Flight | null = null;
  private authoritativeIdentity: AssistantSelectionIdentity | null = null;

  constructor(private readonly onBusyChange: (busy: boolean) => void, private readonly onError: (error: unknown) => void) {}

  activate(identity: AssistantSelectionIdentity) {
    if (this.authoritativeIdentity && !sameIdentity(this.authoritativeIdentity, identity) && this.flight) this.retire(this.flight);
    this.authoritativeIdentity = identity;
  }

  enqueue(identity: AssistantSelectionIdentity, selection: AssistantSelection, execute: (item: { identity: AssistantSelectionIdentity; selection: AssistantSelection; signal: AbortSignal }) => Promise<void>) {
    if (!this.isAuthoritative(identity)) return Promise.reject(new AssistantSelectionStaleError());
    let flight = this.flight;
    if (!flight) {
      flight = { identity, controller: new AbortController(), running: false, desired: null, waiters: [], activeWaiters: [], idleWaiters: [], retired: false };
      this.flight = flight;
    }
    flight.desired = selection;
    const promise = new Promise<void>((resolve, reject) => { flight!.waiters.push({ resolve, reject }); });
    if (!flight.running) {
      flight.running = true;
      this.onBusyChange(true);
      void this.run(flight, execute);
    }
    return promise;
  }

  async flush(identity: AssistantSelectionIdentity) {
    if (!this.isAuthoritative(identity)) throw new AssistantSelectionStaleError();
    const flight = this.flight;
    if (!flight?.running) return;
    await new Promise<void>((resolve, reject) => flight.idleWaiters.push({ resolve, reject }));
  }

  assertAuthoritative(identity: AssistantSelectionIdentity) {
    if (!this.isAuthoritative(identity)) throw new AssistantSelectionStaleError();
  }

  dispose() {
    if (this.flight) this.retire(this.flight);
    this.authoritativeIdentity = null;
  }

  private async run(flight: Flight, execute: (item: { identity: AssistantSelectionIdentity; selection: AssistantSelection; signal: AbortSignal }) => Promise<void>) {
    while (!flight.retired && flight.desired) {
      const selection = flight.desired;
      flight.desired = null;
      const waiters = flight.waiters.splice(0);
      flight.activeWaiters = waiters;
      try {
        await execute({ identity: flight.identity, selection, signal: flight.controller.signal });
        if (!flight.retired) for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        if (!flight.retired) {
          this.onError(error);
          for (const waiter of waiters) waiter.reject(error);
        }
      }
      flight.activeWaiters = [];
    }
    flight.running = false;
    for (const waiter of flight.idleWaiters.splice(0)) waiter.resolve();
    if (this.flight === flight) this.onBusyChange(false);
  }

  private retire(flight: Flight) {
    flight.retired = true;
    flight.controller.abort();
    const error = new AssistantSelectionStaleError();
    for (const waiter of flight.activeWaiters.splice(0)) waiter.reject(error);
    for (const waiter of flight.waiters.splice(0)) waiter.reject(error);
    for (const waiter of flight.idleWaiters.splice(0)) waiter.reject(error);
    if (this.flight === flight) {
      this.flight = null;
      this.onBusyChange(false);
    }
  }

  private isAuthoritative(identity: AssistantSelectionIdentity) {
    return this.authoritativeIdentity !== null && sameIdentity(this.authoritativeIdentity, identity);
  }
}
