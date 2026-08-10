import { describe, expect, it, vi } from "vitest";
import { createTerminalOutputFlowControl } from "./terminalFlowControl";

function bytes(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe("createTerminalOutputFlowControl", () => {
  it("pauses after the high-water mark and resumes below the low-water mark", () => {
    const writes: Array<() => void> = [];
    const messages: string[] = [];
    const flow = createTerminalOutputFlowControl({
      write: (_data, callback) => {
        if (callback) writes.push(callback);
      },
      send: (message) => {
        messages.push(message.type);
        return true;
      },
      limit: 4,
      highWater: 1,
      lowWater: 2,
    });

    flow.write(bytes(5));
    flow.write(bytes(5));

    expect(messages).toEqual(["pause"]);
    expect(writes).toHaveLength(2);

    writes[0]();

    expect(messages).toEqual(["pause", "resume"]);
  });

  it("does not add xterm completion callbacks below the byte limit", () => {
    const write = vi.fn();
    const flow = createTerminalOutputFlowControl({
      write,
      send: () => true,
      limit: 8,
      highWater: 2,
      lowWater: 1,
    });

    flow.write(bytes(8));

    expect(write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]).toHaveLength(1);
  });

  it("tracks a caller callback even when the byte limit is not reached", () => {
    const callback = vi.fn();
    const writes: Array<() => void> = [];
    const flow = createTerminalOutputFlowControl({
      write: (_data, completion) => {
        if (completion) writes.push(completion);
      },
      send: () => true,
      limit: 1024,
      highWater: 0,
      lowWater: 1,
    });

    flow.write(bytes(1), callback);

    expect(writes).toHaveLength(1);
    expect(callback).not.toHaveBeenCalled();
    writes[0]();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("retries flow control after the socket becomes writable", () => {
    const writes: Array<() => void> = [];
    const messages: string[] = [];
    let canSend = false;
    const flow = createTerminalOutputFlowControl({
      write: (_data, callback) => {
        if (callback) writes.push(callback);
      },
      send: (message) => {
        messages.push(message.type);
        return canSend;
      },
      limit: 4,
      highWater: 0,
      lowWater: 1,
    });

    flow.write(bytes(5));
    expect(messages).toEqual(["pause"]);

    canSend = true;
    flow.connectionReady();
    expect(messages).toEqual(["pause", "pause"]);

    writes[0]();
    expect(messages).toEqual(["pause", "pause", "resume"]);
  });
});
