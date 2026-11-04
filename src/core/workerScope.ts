/**
 * Typed access to the dedicated-worker global scope. The project compiles with the DOM lib
 * (not the WebWorker lib), so worker entry files use `workerSelf` instead of `self`.
 */
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close(): void;
}

export const workerSelf = self as unknown as WorkerScope;
