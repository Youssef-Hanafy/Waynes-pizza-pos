import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { Client } from "pg";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";

export const workspaceId = "40000000-0000-4000-8000-000000000001";
export const ownerId = "79000000-0000-4000-8000-000000000001";
const categoryId = "79000000-0000-4000-8000-000000000002";
const itemId = "79000000-0000-4000-8000-000000000003";

/** Always creates its own local cluster. Never reads a connection URL or .env. */
export async function startTipPostgres() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No local test port");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const directory = await mkdtemp(join(tmpdir(), "wayne-tip-postgres-"));
  const cluster = new EmbeddedPostgres({
    databaseDir: directory, port, user: "tip_test", password: randomUUID(), persistent: false,
    createPostgresUser: false, postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "max_connections=30"],
    onLog: () => {}, onError: () => {},
  });
  await cluster.initialise();
  await cluster.start();
  const clients: Client[] = [];
  async function connect() {
    const client = cluster.getPgClient("postgres", "127.0.0.1");
    await client.connect();
    clients.push(client);
    return client;
  }
  const admin = await connect();
  try {
    await admin.query(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,last_sign_in_at timestamptz,raw_user_meta_data jsonb not null default '{}'::jsonb);
      create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);
      grant usage on schema public to anon, authenticated, service_role;
    `);
    for (const file of (await readdir("supabase/migrations")).filter((file) => file.endsWith(".sql")).sort()) {
      await admin.query(await readFile(join("supabase/migrations", file), "utf8"));
    }
    await admin.query(`
      insert into auth.users(id,email) values('${ownerId}','tip-test@example.invalid');
      update public.profiles set active=true, role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.store_settings set test_ordering_enabled=true, pickup_minimum_cents=0, delivery_minimum_cents=0, tips_enabled=true;
      insert into public.menu_categories(id,name) values('${categoryId}','Tip concurrency fixture');
      insert into public.menu_items(id,category_id,name,base_price_cents,pos_visible) values('${itemId}','${categoryId}','Test item',2000,true);
    `);
  } catch (error) {
    await Promise.all(clients.map((client) => client.end()));
    await cluster.stop();
    throw error;
  }

  async function fixture() {
    await admin.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${ownerId}',true);`);
    const payload = { idempotency_key: randomUUID(), customer_mode: "walk_in", source: "pos", fulfillment_type: "pickup", payment_method: "test_manual", items: [{ menu_item_id: itemId, variant_id: null, quantity: 1, modifiers: [], special_instructions: "" }] };
    const order = (await admin.query("select public.wayne_create_pos_order($1) value", [JSON.stringify(payload)])).rows[0].value as { id: string; total_cents: number };
    await admin.query("commit");
    const paymentId = randomUUID();
    const originalId = `pi_original_${paymentId.replaceAll("-", "")}`;
    await admin.query(`insert into public.payments(id,order_id,provider,provider_payment_id,method,amount_cents,status,authorized_at,metadata)
      values($1,$2,'stripe',$3,'card',$4,'authorized',now(),'{"tip_adjust":true}')`, [paymentId, order.id, originalId, order.total_cents]);
    return { orderId: order.id, paymentId, originalId, amount: order.total_cents };
  }

  /** PostgREST transport substitute only: every RPC runs real SQL on a separate connection. */
  async function service() {
    const client = await connect();
    let failRpc: string | null = null;
    let loseRpc: string | null = null;
    const api = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (failRpc === name) { failRpc = null; return { data: null, error: { message: "Injected lost database response", code: "08006" } }; }
        if (!/^wayne_[a-z_]+$/.test(name)) throw new Error("Unexpected test RPC");
        try {
          await client.query("begin; set local role service_role");
          const entries = Object.entries(args);
          const result = await client.query(`select public.${name}(${entries.map(([key], index) => `${key} => $${index + 1}`).join(",")}) value`, entries.map(([, value]) => value !== null && typeof value === "object" ? JSON.stringify(value) : value));
          await client.query("commit");
          if (loseRpc === name) { loseRpc = null; return { data: null, error: { message: "Injected response lost AFTER commit", code: "08006" } }; }
          return { data: result.rows[0].value, error: null };
        } catch (error) {
          await client.query("rollback");
          return { data: null, error: { message: (error as Error).message, code: (error as { code?: string }).code } };
        }
      },
      from: (table: string) => {
        if (table !== "payments") throw new Error(`Unexpected test table ${table}`);
        const predicates: string[] = [], values: unknown[] = [];
        let update: Record<string, unknown> | null = null;
        const add = (column: string, operator: string, value: unknown) => {
          if (!/^[a-z_.]+$/.test(column)) throw new Error("Invalid test column");
          values.push(value); predicates.push(`${column.startsWith("orders.") ? column.replace("orders.", "o.") : `p.${column}`} ${operator} $${values.length}${operator === "= any(" ? ")" : ""}`);
        };
        const query = {
          select: () => query,
          eq: (column: string, value: unknown) => { add(column, "=", value); return query; },
          in: (column: string, value: unknown[]) => { add(column, "= any(", value); return query; },
          order: () => query,
          update: (value: Record<string, unknown>) => { update = value; return query; },
          then: async (resolve: (result: unknown) => unknown) => {
            try {
            if (update) {
              const assignments = Object.entries(update).map(([key, value]) => { values.push(typeof value === "object" ? JSON.stringify(value) : value); return `${key}=$${values.length}`; });
              await client.query(`update public.payments p set ${assignments.join(",")} where ${predicates.join(" and ")}`, values);
              return resolve({ data: null, error: null });
            }
            const result = await client.query(`select p.*, jsonb_build_object('workspace_id',o.workspace_id,'order_number',o.order_number) as "order" from public.payments p join public.orders o on o.id=p.order_id where ${predicates.join(" and ")} order by p.created_at desc`, values);
            return resolve({ data: result.rows, error: null });
            } catch (error) { return resolve({ data: null, error: { message: (error as Error).message } }); }
          },
        };
        return query;
      },
    };
    return { client, api: api as unknown as ReturnType<typeof createServiceSupabaseClient>, failNextRpc: (name: string) => { failRpc = name; }, loseNextRpcResponse: (name: string) => { loseRpc = name; } };
  }
  const closeTestClients = async () => { await Promise.all(clients.splice(1).map((client) => client.end())); };
  return { admin, connect, fixture, service, closeTestClients, stop: async () => { await closeTestClients(); await admin.end(); await cluster.stop(); } };
}
