import type { GroupState } from './types.js';

export class ClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ClientError';
  }
}

/** Network failure, timeout, or any error before we got valid XML back. */
export class TransportError extends ClientError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

export interface ProtocolErrorEntry {
  point: string;
  code: string;
  message: string;
}

/**
 * The controller returned a structured error envelope (`getErrorResponse` /
 * `setErrorResponse`) with no usable result. For partial-write cases where
 * some attributes did persist, see {@link PartialWriteError}.
 */
export class ProtocolError extends ClientError {
  readonly errors: ProtocolErrorEntry[];
  constructor(message: string, errors: ProtocolErrorEntry[]) {
    super(message);
    this.name = 'ProtocolError';
    this.errors = errors;
  }
}

/**
 * A `setErrorResponse` came back, but at least one of the attributes we asked
 * to change did persist on the controller. `readback` is the authoritative
 * state of the affected group, freshly polled after the failed write.
 */
export class PartialWriteError extends ClientError {
  readonly group: number;
  readonly errors: ProtocolErrorEntry[];
  readonly readback: GroupState;
  constructor(group: number, errors: ProtocolErrorEntry[], readback: GroupState) {
    super(
      `Partial write to group ${group}: ${errors
        .map((e) => `${e.point} (${e.code} ${e.message})`)
        .join(', ')}`,
    );
    this.name = 'PartialWriteError';
    this.group = group;
    this.errors = errors;
    this.readback = readback;
  }
}
