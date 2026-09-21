import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { isPhoneLineNumber, status, type HardwareStatus, type IncomingCallEvent } from "../types";
import { CallListeners, type CallerIdProvider } from "./provider";

type PhoneCallRow = {
  id: string;
  event_key: string;
  line_number: number;
  device_id: string | null;
  direction: string;
  caller_number: string | null;
  caller_number_raw: string;
  caller_name: string;
  started_at: string;
  status: string;
  raw_record: string | null;
};

/**
 * Rings that reached the database some other way — the store's caller ID
 * bridge (`scripts/callerid-bridge.mjs` → /api/phone/calls) or another
 * register's provider — pushed to this register by Supabase Realtime (§21, §22).
 *
 * This is what replaces the old three-second poll: nothing is fetched until
 * the database says something changed.
 */
export class CloudCallerIdProvider implements CallerIdProvider {
  readonly kind = "cloud" as const;
  private listeners = new CallListeners();
  private changeListeners = new Set<(serverCallId: string | null) => void>();
  private channel: RealtimeChannel | null = null;
  private state: HardwareStatus = status("disconnected", "Connecting", "Waiting for the live connection.");

  constructor(private readonly client: SupabaseClient | null) {}

  async start() {
    if (!this.client) {
      this.state = status("unavailable", "Offline", "The live connection is not configured on this device.");
      return;
    }
    if (this.channel) return;
    this.channel = this.client
      .channel(`wayne-phone-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "phone_calls" }, (payload) => {
        const row = payload.new as PhoneCallRow;
        this.emitChange(row.id);
        if (row.direction !== "inbound" || row.status !== "incoming" || !isPhoneLineNumber(row.line_number)) return;
        const event: IncomingCallEvent = {
          id: row.event_key,
          serverCallId: row.id,
          deviceId: row.device_id || undefined,
          line: row.line_number,
          phoneNumber: row.caller_number ?? row.caller_number_raw,
          callerName: row.caller_name || null,
          occurredAt: row.started_at,
          rawPayload: row.raw_record || undefined,
          source: "cloud",
        };
        this.listeners.emit(event);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "phone_calls" }, (payload) => {
        this.emitChange((payload.new as PhoneCallRow).id);
      })
      .subscribe((state) => {
        if (state === "SUBSCRIBED") {
          this.state = status("connected", "Live", "Other registers and the store bridge reach this screen instantly.");
          // Anything that happened while we were connecting is picked up once.
          this.emitChange(null);
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          this.state = status("disconnected", "Reconnecting", "The live connection dropped. Calls from other registers will appear when it is back.");
        } else if (state === "CLOSED") {
          this.state = status("disconnected", "Offline", "The live connection is closed.");
        }
      });
  }

  async stop() {
    if (this.client && this.channel) await this.client.removeChannel(this.channel);
    this.channel = null;
    this.state = status("disconnected", "Stopped");
  }

  async getStatus() {
    return this.state;
  }

  onIncomingCall(callback: (event: IncomingCallEvent) => void) {
    return this.listeners.add(callback);
  }

  /** A call row changed anywhere (claimed, dismissed, turned into an order). */
  onCallChanged(callback: (serverCallId: string | null) => void) {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }

  private emitChange(id: string | null) {
    for (const listener of [...this.changeListeners]) listener(id);
  }
}
