import { Agent, request } from 'undici';
import { TransportError } from './errors.js';
import { parsePacket, type PacketRoot } from './xml.js';

const SERVLET_PATH = '/servlet/MIMEReceiveServlet';

export interface TransportOptions {
  host: string;
  port: number;
  requestTimeoutMs: number;
}

/**
 * HTTP transport for the G-50A's MIME servlet.
 *
 * The controller is HTTP/1.0 and single-threaded; pipelined or concurrent
 * requests interleave responses. We serialize all calls through one async
 * queue and explicitly disable connection keep-alive on the dispatcher.
 */
export class Transport {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Agent;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: TransportOptions) {
    this.url = `http://${opts.host}:${opts.port}${SERVLET_PATH}`;
    this.timeoutMs = opts.requestTimeoutMs;
    this.dispatcher = new Agent({
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
      pipelining: 0,
      connections: 1,
    });
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  /**
   * POST one XML envelope. Calls are serialized; concurrent callers wait
   * their turn. Returns the parsed response packet.
   */
  send(body: string): Promise<PacketRoot> {
    const run = async (): Promise<PacketRoot> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await request(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml',
            Connection: 'close',
          },
          body,
          signal: controller.signal,
          dispatcher: this.dispatcher,
        });
        const text = await response.body.text();
        if (response.statusCode >= 400) {
          throw new TransportError(
            `Controller returned HTTP ${response.statusCode}: ${text.slice(0, 200)}`,
          );
        }
        return parsePacket(text);
      } catch (cause) {
        if (cause instanceof TransportError) throw cause;
        const message =
          cause instanceof Error && cause.name === 'AbortError'
            ? `Request timed out after ${this.timeoutMs}ms`
            : `Transport failure: ${(cause as Error)?.message ?? String(cause)}`;
        throw new TransportError(message, { cause });
      } finally {
        clearTimeout(timer);
      }
    };

    const next = this.queue.then(run, run);
    // Swallow rejections on the queue chain so one failure doesn't poison the next call.
    this.queue = next.catch(() => undefined);
    return next;
  }
}
