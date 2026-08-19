'use client';

/**
 * Cross-tab notification emitted after a figure render creates a new version.
 *
 * Canvas panels that follow the latest version use this signal to refresh
 * immediately instead of waiting for a tab visibility transition or a manual
 * reload.  BroadcastChannel is the primary transport; the storage event keeps
 * older/private browser contexts working, and the CustomEvent covers listeners
 * in the same document (for example edits made from the canvas sidebar).
 */
export interface FigureVersionCreatedEvent {
  figureId: string;
  versionId: string;
  versionNumber: number;
  source?: 'figure-editor' | 'canvas-editor';
  createdAt: number;
}

const CHANNEL_NAME = 'labplot.figure-versions';
const STORAGE_KEY = 'labplot.figure-version-created';
const WINDOW_EVENT = 'labplot:figure-version-created';

function isFigureVersionCreatedEvent(value: unknown): value is FigureVersionCreatedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<FigureVersionCreatedEvent>;
  return typeof event.figureId === 'string'
    && typeof event.versionId === 'string'
    && typeof event.versionNumber === 'number'
    && Number.isFinite(event.versionNumber)
    && typeof event.createdAt === 'number';
}

export function publishFigureVersionCreated(
  event: Omit<FigureVersionCreatedEvent, 'createdAt'>,
): FigureVersionCreatedEvent {
  const message: FigureVersionCreatedEvent = { ...event, createdAt: Date.now() };
  if (typeof window === 'undefined') return message;

  window.dispatchEvent(new CustomEvent<FigureVersionCreatedEvent>(WINDOW_EVENT, { detail: message }));

  if ('BroadcastChannel' in window) {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(message);
      channel.close();
    } catch {
      // Some embedded/partitioned browsing contexts expose the constructor
      // but reject channel creation or posting. Same-document CustomEvent and
      // the storage fallback below must still complete the success path.
    }
  }

  try {
    // Include the timestamp so repeated edits to the same version-shaped test
    // payload still change the storage value and dispatch in other tabs.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Storage can be unavailable in private/locked-down contexts. The
    // same-document event has already been dispatched above.
  }
  return message;
}

export function subscribeToFigureVersions(
  listener: (event: FigureVersionCreatedEvent) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  const seenSignatures = new Set<string>();
  const latestByFigure = new Map<string, FigureVersionCreatedEvent>();
  const deliver = (event: FigureVersionCreatedEvent) => {
    const signature = `${event.figureId}:${event.versionId}:${event.createdAt}`;
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);
    if (seenSignatures.size > 100) {
      const oldest = seenSignatures.values().next().value;
      if (oldest) seenSignatures.delete(oldest);
    }

    // BroadcastChannel and storage events are separate transports and can be
    // delivered in different orders. Never let a delayed copy of an older
    // version rotate a follow-latest canvas panel backwards.
    const latest = latestByFigure.get(event.figureId);
    if (latest && (
      event.versionNumber < latest.versionNumber
      || (event.versionNumber === latest.versionNumber && event.createdAt <= latest.createdAt)
    )) return;
    latestByFigure.set(event.figureId, event);
    listener(event);
  };

  const onWindowEvent = (raw: Event) => {
    const event = (raw as CustomEvent<unknown>).detail;
    if (isFigureVersionCreatedEvent(event)) deliver(event);
  };
  const onStorage = (raw: StorageEvent) => {
    if (raw.key !== STORAGE_KEY || !raw.newValue) return;
    try {
      const event: unknown = JSON.parse(raw.newValue);
      if (isFigureVersionCreatedEvent(event)) deliver(event);
    } catch {
      // Ignore malformed values written by extensions or older app versions.
    }
  };

  window.addEventListener(WINDOW_EVENT, onWindowEvent);
  window.addEventListener('storage', onStorage);

  let channel: BroadcastChannel | null = null;
  if ('BroadcastChannel' in window) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null;
    }
  }
  if (channel) {
    channel.onmessage = (raw: MessageEvent<unknown>) => {
      if (isFigureVersionCreatedEvent(raw.data)) deliver(raw.data);
    };
  }

  return () => {
    window.removeEventListener(WINDOW_EVENT, onWindowEvent);
    window.removeEventListener('storage', onStorage);
    try {
      channel?.close();
    } catch {
      // A context can be torn down before cleanup; listeners above are still
      // removed and no caller should fail because channel.close did.
    }
  };
}
