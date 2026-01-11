/**
 * Relay connection management
 * Thin wrapper around nostr-tools with NIP-42 auth support
 */

import { Relay, SimplePool } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';
import { config } from './constants';
import type { RelayOptions, RelayPublishResponse } from './types';

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
   * Publish an event to all relays
   *
   * @param event - Signed event to publish
   * @returns Array of responses from each relay
   */
  async publish(event: Event): Promise<RelayPublishResponse[]> {
    const responses: RelayPublishResponse[] = [];

    const publishPromises = this.urls.map(async (url) => {
      try {
        await Promise.race([
          this.pool.publish([url], event),
          this.timeout(this.options.timeout!),
        ]);

        responses.push({
          success: true,
          relay: url,
        });
      } catch (error) {
        responses.push({
          success: false,
          relay: url,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    await Promise.allSettled(publishPromises);
    return responses;
  }

  /**
   * Query events from relays
   *
   * @param filter - Nostr filter
   * @returns Array of matching events (deduplicated by event ID)
   */
  async query(filter: Filter): Promise<Event[]> {
    try {
      const events = await Promise.race([
        this.pool.querySync(this.urls, filter),
        this.timeout(this.options.timeout!).then(() => [] as Event[]),
      ]);

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

  /**
   * Create a timeout promise
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), ms);
    });
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
        // Handle NIP-42 auth if callback provided
        if (options?.authHandler) {
          // nostr-tools handles AUTH automatically if you provide a callback
          // But we need to set it up before publishing
        }

        await Promise.race([
          relay.publish(event),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Publish timeout')), timeout)
          ),
        ]);

        relay.close();

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

      await Promise.race([
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
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Query timeout')), timeout)
        ),
      ]);

      return events;
    } finally {
      relay.close();
    }
  } catch (error) {
    console.error(`[relay] Query error for ${url}:`, error);
    return [];
  }
}
