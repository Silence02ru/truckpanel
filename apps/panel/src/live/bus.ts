import { EventEmitter } from 'node:events';
import type { HostMetrics, ServerMetrics, ServerSummary, Task } from '@truckpanel/shared';

/** Server-side events pushed to WebSocket clients (SPEC.md "WebSocket events"). */
export type LiveEvent =
  | { event: 'server.status'; serverId: string; data: ServerSummary }
  | { event: 'server.removed'; serverId: string; data: null }
  | { event: 'task.progress'; serverId: string; data: Task }
  | { event: 'server.console'; serverId: string; data: { lines: ConsoleLine[] } }
  | { event: 'server.players'; serverId: string; data: { online: number; max: number; players: PlayerView[] } }
  | { event: 'server.metrics'; serverId: string; data: ServerMetrics }
  | { event: 'host.metrics'; serverId?: undefined; data: HostMetrics };

export interface ConsoleLine {
  /** Arrival time on the panel (the DS log has no timestamps of its own). */
  ts: string;
  text: string;
}

export interface PlayerView {
  name: string;
  clientId: number | null;
  connectedSince: string;
}

/** In-process pub/sub between the managers and the WebSocket hub. */
export class LiveBus extends EventEmitter {
  publish(e: LiveEvent): void {
    this.emit('event', e);
  }
  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}
