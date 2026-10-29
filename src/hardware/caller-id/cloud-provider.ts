import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { isPhoneLineNumber, status, type HardwareStatus, type IncomingCallEvent } from "../types";
import { CallListeners, type CallerIdProvider } from "./provider";
import { workspaceRealtimeFilter } from "@/lib/tenancy/client-scope";

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
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;

  constructor(private readonly client: SupabaseClient | null) {}

  /** True while Supabase Realtime is delivering phone changes to this register. */
  isLive() {
    return this.state.state === "connected";
  }

  async start() {
    if (!this.client) {
      this.state = status("unavailable", "Offline", "The live connection is not configured on this device.");
      return;
    }
    this.stopped = false;
    if (this.channel) return;
    this.subscribe();
  }

  /**
   * A dropped live connection is rebuilt by itself (owner, 2026-10-29: the
   * caller ID box "sometimes just doesn't show up").  Before, a channel that
   * errored, timed out or closed (Wi-Fi blip, tablet asleep) stayed down until
   * the POS was reopened, so rings recorded by the store bridge or another
   * register never reached this screen.  Now: rejoin after 2 s, 4 s, 8 s … up
   * to 30 s, and pull the board once when it is back.
   */
  private reconnectSoon() {
    if (this.stopped || this.retryTimer || !this.client) return;
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(this.retries, 4));
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped || !this.client) return;
      const old = this.channel;
      this.channel = null;
      if (old) void this.client.removeChannel(old).catch(() => undefined);
      this.subscribe();
    }, delay);
  }

  private subscribe() {
    if (!this.client) return;
    const channel: RealtimeChannel = this.client
      .channel(`hanafy-phone-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "phone_calls", ...workspaceRealtimeFilter() }, (payload) => {
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
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "phone_calls", ...workspaceRealtimeFilter() }, (payload) => {
        this.emitChange((payload.new as PhoneCallRow).id);
      });
    this.channel = channel;
    channel.subscribe((state) => {
        // Only the current channel speaks: a replaced one reporting CLOSED must not start another reconnect.
        if (this.stopped || this.channel !== channel) return;
        if (state === "SUBSCRIBED") {
          this.retries = 0;
          this.state = status("connected", "Live", "Other registers and the store bridge reach this screen instantly.");
          // Anything that happened while we were connecting is picked up once.
          this.emitChange(null);
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          this.state = status("disconnected", "Reconnecting", "The live connection dropped. Calls from other registers will appear when it is back.");
          this.reconnectSoon();
        } else if (state === "CLOSED") {
          this.state = status("disconnected", "Reconnecting", "The live connection closed. Reconnecting.");
          this.reconnectSoon();
        }
      });
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const channel = this.channel;
    this.channel = null;
    if (this.client && channel) await this.client.removeChannel(channel);
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
