#!/usr/bin/env node
/**
 * Wayne's Pizza — caller ID bridge.
 *
 * The store's phone lines run through a "Whozz Calling?" Ethernet unit from
 * CallerID.com (the same hardware Thrive uses).  Every time a line rings, the
 * unit broadcasts a UDP packet on port 3520 describing the ring.  A web browser
 * cannot listen for UDP, so this tiny program does: it sits on any computer in
 * the store, catches the broadcast, and posts it to Wayne's website, which
 * matches the number to a customer and lights up the POS phone panel.
 *
 * Run it on the counter computer:
 *
 *   WAYNES_URL=https://waynespizzaofworcester.com \
 *   CALLER_ID_INGEST_TOKEN=<the same token set on the website> \
 *   node scripts/callerid-bridge.mjs
 *
 * It needs nothing installed, keeps no data, and reconnects by itself.  If the
 * internet drops, rings are lost rather than queued — a call that already ended
 * is not worth popping five minutes later.
 */

import { createSocket } from "node:dgram";

const url = (process.env.WAYNES_URL || "http://localhost:3000").replace(/\/+$/, "");
const token = process.env.CALLER_ID_INGEST_TOKEN || "";
const port = Number(process.env.CALLER_ID_UDP_PORT || 3520);
const endpoint = `${url}/api/phone/calls`;

if (!token) {
  console.error("CALLER_ID_INGEST_TOKEN is required. It must match the value set on the website.");
  process.exit(1);
}

const socket = createSocket({ type: "udp4", reuseAddr: true });

socket.on("error", (error) => {
  console.error(`[callerid] socket error: ${error.message}`);
  socket.close();
  // Let the process supervisor restart us rather than limping on half-open.
  process.exit(1);
});

socket.on("listening", () => {
  socket.setBroadcast(true);
  const address = socket.address();
  console.log(`[callerid] listening on ${address.address}:${address.port} -> ${endpoint}`);
});

socket.on("message", async (message, remote) => {
  const raw = message.toString("latin1").replace(/\0/g, "").trim();
  if (!raw) return;
  console.log(`[callerid] ${remote.address}: ${raw}`);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ raw, occurred_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[callerid] website returned HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
  } catch (error) {
    console.error(`[callerid] could not reach the website: ${error instanceof Error ? error.message : error}`);
  }
});

socket.bind(port);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("[callerid] stopping");
    socket.close(() => process.exit(0));
  });
}
