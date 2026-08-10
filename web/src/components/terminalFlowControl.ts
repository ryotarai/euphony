export type TerminalFlowControlMessage = {
  type: "pause" | "resume";
};

export interface TerminalOutputFlowControlOptions {
  write(data: Uint8Array, callback?: () => void): void;
  send(message: TerminalFlowControlMessage): boolean;
  limit?: number;
  highWater?: number;
  lowWater?: number;
  onStateChange?(pending: number, paused: boolean): void;
}

export interface TerminalOutputFlowControl {
  write(data: Uint8Array, callback?: () => void): void;
  connectionReady(): void;
  dispose(): void;
  readonly pending: number;
  readonly paused: boolean;
}

const defaultLimit = 100_000;
const defaultHighWater = 10;
const defaultLowWater = 4;

// xterm writes are asynchronous once its internal parser queue is busy. Keep
// small writes cheap, then use completion callbacks as a per-connection
// signal for the server's output gate.
export function createTerminalOutputFlowControl(
  options: TerminalOutputFlowControlOptions,
): TerminalOutputFlowControl {
  const limit = Math.max(0, options.limit ?? defaultLimit);
  const highWater = Math.max(0, options.highWater ?? defaultHighWater);
  const lowWater = Math.max(0, options.lowWater ?? defaultLowWater);
  let written = 0;
  let pendingWrites = 0;
  let paused = false;
  let disposed = false;

  const notifyState = () => {
    options.onStateChange?.(pendingWrites, paused);
  };

  const reconcile = () => {
    if (disposed) return;
    if (paused) {
      if (pendingWrites < lowWater && options.send({ type: "resume" })) {
        paused = false;
        notifyState();
      }
      return;
    }
    if (pendingWrites > highWater && options.send({ type: "pause" })) {
      paused = true;
      notifyState();
    }
  };

  const write = (data: Uint8Array, callback?: () => void) => {
    if (data.byteLength === 0) {
      callback?.();
      return;
    }
    if (disposed) {
      options.write(data, callback);
      return;
    }

    written += data.byteLength;
    const shouldTrack = callback !== undefined || written > limit;
    if (!shouldTrack) {
      options.write(data);
      return;
    }
    if (written > limit) written = 0;

    let completed = false;
    pendingWrites++;
    notifyState();
    const complete = () => {
      if (completed) return;
      completed = true;
      pendingWrites = Math.max(0, pendingWrites - 1);
      notifyState();
      try {
        callback?.();
      } finally {
        reconcile();
      }
    };
    try {
      options.write(data, complete);
    } catch (error) {
      complete();
      throw error;
    }
    reconcile();
  };

  return {
    write,
    connectionReady: reconcile,
    dispose() {
      disposed = true;
    },
    get pending() {
      return pendingWrites;
    },
    get paused() {
      return paused;
    },
  };
}
