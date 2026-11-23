/// <reference lib="webworker" />
import { createWorkerHandler } from './handler';
import type { ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const handle = createWorkerHandler((message, transfer) => self.postMessage(message, transfer));
self.onmessage = (event: MessageEvent<ToWorker>) => handle(event.data);
