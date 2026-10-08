/**
 * Relay connection management
 * Thin wrapper around nostr-tools with NIP-42 auth support
 */

import { Relay, SimplePool } from 'nostr-tools';
import type { Event, EventTemplate, Filter, VerifiedEvent } from 'nostr-tools';
import { config } from './constants';
import type { RelayOptions, RelayPublishResponse } from './types';

/**
 * Race a promise against a timer, always clearing the timer so it does not
 * keep the process alive.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Managed relay pool for publishing and querying events
 */
export class RelayPool {
  private urls: string[];
  private options: RelayOptions;
  private pool: SimplePool;

  constructor(urls: string[], options?: RelayOptions) {
    this.urls = urls;
    this.options = {
      timeout: options?.timeout ?? config.relayTimeout,
      retries: options?.retries ?? config.relayRetries,
      authHandler: options?.authHandler,
    };
    this.pool = new SimplePool();
  }

  /**
   * Publish an event to all relays.
   *
   * A relay counts as successful only when it answers `OK true`. An `OK false`
   * (e.g. strfry's "event too large"), a timeout or a connection error is a
   * failure, with the relay's reason in `message`.
   *
   * @param event - Signed event to publish
   * @returns Array of responses from each relay
   */
  async publish(event: Event): Promise<RelayPublishResponse[]> {
    const authHandler = this.options.authHandler;
    const onauth = authHandler
      ? async (template: EventTemplate): Promise<VerifiedEvent> => {
          const challenge = template.tags.find((tag) => tag[0] === 'challenge')?.[1] ?? '';
          return (await authHandler(challenge)) as VerifiedEvent;
        }
      : undefined;

    return Promise.all(this.urls.map(async (url): Promise<RelayPublishResponse> => {
      try {
        // SimplePool.publish returns one promise per relay; it resolves on
        // OK=true and rejects on OK=false. Await it, do not just call it.
        const [ack] = this.pool.publish([url], event, onauth ? { onauth } : undefined);
        const reason = await withTimeout(ack, this.options.timeout!, 'Timeout');
        return { success: true, relay: url, message: reason };
      } catch (error) {
        return { success: false, relay: url, message: errorMessage(error) };
      }
    }));
  }

  /**
   * Query events from relays
   *
   * @param filter - Nostr filter
   * @returns Array of matching events (deduplicated by event ID). On timeout
   *   or error, returns what arrived so far (possibly []).
   */
  async query(filter: Filter): Promise<Event[]> {
    try {
      const events = await this.pool.querySync(this.urls, filter, { maxWait: this.options.timeout });

      // Deduplicate by event ID
      const seen = new Set<string>();
      return events.filter((e: Event) => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
    } catch (error) {
      console.error('[relay] Query error:', error);
      return [];
    }
  }

  /**
   * Query for a single event from relays
   *
   * @param filter - Nostr filter
   * @returns First matching event or null
   */
  async queryOne(filter: Filter): Promise<Event | null> {
    const events = await this.query({ ...filter, limit: 1 });
    return events.length > 0 ? events[0] : null;
  }

  /**
   * Close all relay connections
   */
  close(): void {
    this.pool.close(this.urls);
  }
}

/**
 * Publish an event to a single relay with retry logic
 *
 * @param url - Relay URL
 * @param event - Signed event to publish
 * @param options - Relay options
 * @returns Publish response
 */
export async function publishToRelay(
  url: string,
  event: Event,
  options?: RelayOptions
): Promise<RelayPublishResponse> {
  const timeout = options?.timeout ?? config.relayTimeout;
  const retries = options?.retries ?? config.relayRetries;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const relay = await Relay.connect(url);

      try {
        await withTimeout(relay.publish(event), timeout, 'Publish timeout');

        return {
          success: true,
          relay: url,
        };
      } finally {
        relay.close();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');
      if (attempt < retries) {
        // Wait before retry with exponential backoff
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  return {
    success: false,
    relay: url,
    message: lastError?.message ?? 'Failed after retries',
  };
}

/**
 * Query events from a single relay
 *
 * @param url - Relay URL
 * @param filter - Nostr filter
 * @param options - Relay options
 * @returns Array of matching events
 */
export async function queryRelay(
  url: string,
  filter: Filter,
  options?: RelayOptions
): Promise<Event[]> {
  const timeout = options?.timeout ?? config.relayTimeout;

  try {
    const relay = await Relay.connect(url);

    try {
      const events: Event[] = [];

      await withTimeout(
        new Promise<void>((resolve) => {
          const sub = relay.subscribe([filter], {
            onevent(event: Event) {
              events.push(event);
            },
            oneose() {
              sub.close();
              resolve();
            },
          });
        }),
        timeout,
        'Query timeout',
      );

      return events;
    } finally {
      relay.close();
    }
  } catch (error) {
    console.error(`[relay] Query error for ${url}:`, error);
    return [];
  }
}
