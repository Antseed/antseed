/**
 * Process-wide telemetry service holder.
 *
 * main.ts initializes the service once (before `app.whenReady()` so the
 * userData path is stable and crash recovery reads the right file); other
 * main-process modules reach it through `getTelemetryService()` without
 * threading it through every context object.
 */
import type { TelemetryService } from './telemetry.js';

let service: TelemetryService | null = null;

export function setTelemetryService(next: TelemetryService): void {
  service = next;
}

export function getTelemetryService(): TelemetryService | null {
  return service;
}
