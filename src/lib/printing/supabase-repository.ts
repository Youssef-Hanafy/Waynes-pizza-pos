import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { printJobSchema } from "./schemas";
import type { PrinterJob } from "./adapter";
import type { PrintQueueRepository } from "./worker";

const leasedJobSchema = printJobSchema.extend({ status: z.literal("processing"), lease_token: z.uuid() });

/** Inject a trusted agent's authenticated staff client. Never embed service keys
 * in a browser or bypass the database's printing.process permission checks. */
export function createSupabasePrintQueueRepository(client: Pick<SupabaseClient, "rpc">): PrintQueueRepository {
  async function finish(job: PrinterJob, succeeded: boolean, message: string | null) {
    const { error } = await client.rpc("wayne_finish_print_job", {
      target_job_id: job.id, target_lease_token: job.lease_token, succeeded, failure_message: message,
    });
    if (error) throw new Error("Print result could not be saved. Inspect the job before retrying.");
  }
  return {
    async claim(destination, workerId) {
      const { data, error } = await client.rpc("wayne_claim_print_job", {
        target_destination: destination, target_worker_id: workerId,
      });
      if (error) throw new Error("Unable to claim a print job. Check the agent connection and permissions.");
      if (data === null) return null;
      return leasedJobSchema.parse(data);
    },
    complete: (job) => finish(job, true, null),
    fail: (job, error) => finish(job, false, `${error.code}: ${error.message}`.slice(0, 500)),
  };
}
