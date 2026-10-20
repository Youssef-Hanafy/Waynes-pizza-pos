import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { displayPublishResultSchema, displayReadSchema, displayRequestSchema } from "./customer-display";

function displayClient() {
  const client = createBrowserSupabaseClient();
  if (!client) throw new Error("The customer screen connection is unavailable.");
  return client;
}

export async function readCustomerDisplay(key: string) {
  const { data, error } = await displayClient().rpc("wayne_display_read", { screen_key: key.trim().slice(0, 60) }).abortSignal(AbortSignal.timeout(6000));
  if (error) throw new Error("The register could not be reached.");
  return displayReadSchema.parse(data);
}

export async function publishCustomerDisplay(input: unknown) {
  const request = displayRequestSchema.parse(input);
  if (request.kind !== "publish") throw new Error("Invalid customer screen request.");
  const { data, error } = await displayClient().rpc("wayne_display_publish", {
    screen_key: request.key, screen_state: request.state, publisher: request.publisher, changed: request.changed,
  }).abortSignal(AbortSignal.timeout(8000));
  if (error) throw new Error("The customer screen could not be updated.");
  return displayPublishResultSchema.parse(data);
}

export async function respondToCustomerDisplay(key: string, answer: Record<string, unknown>) {
  const request = displayRequestSchema.parse({ kind: "respond", key, answer });
  if (request.kind !== "respond") throw new Error("Invalid customer screen answer.");
  const { data, error } = await displayClient().rpc("wayne_display_respond", { screen_key: request.key, answer: request.answer }).abortSignal(AbortSignal.timeout(10_000));
  if (error || !data || typeof data !== "object" || !("accepted" in data) || data.accepted !== true) {
    throw new Error("Your answer could not be sent. Ask the cashier.");
  }
}

export async function listCustomerDisplays() {
  const { data, error } = await displayClient().rpc("wayne_display_list").abortSignal(AbortSignal.timeout(8000));
  if (error) throw new Error("Registers could not be listed.");
  return Array.isArray(data) ? data.flatMap((row) => row && typeof row === "object" && "display_key" in row ? [String(row.display_key)] : []).filter(Boolean) : [];
}
