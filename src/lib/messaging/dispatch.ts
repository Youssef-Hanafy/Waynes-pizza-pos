import "server-only";

import { logger } from "@/lib/logging/logger";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { credentialsFor, liveSendingError, sendAwsTextMessage, smsSegments } from "./aws-sms";

/** One job as hanafy_message_jobs_claim hands it over. */
export type ClaimedJob = {
  job_id: string;
  lease_token: string;
  workspace_id: string;
  recipient: string;
  body: string;
  message_type: "PROMOTIONAL" | "TRANSACTIONAL";
  origination_identity: string;
  sender_number: string;
  aws_region: string | null;
  live_sending: boolean;
  secret_reference: string | null;
  connection_id: string;
  attempt: number;
};

export type DispatchSummary = { claimed: number; sent: number; failed: number; configuration_failed: number; retried: number; unknown: number; released_campaigns: number };

/**
 * Sends what the database says is due.  The database already re-checked
 * workspace, service, consent, suppression and sender for every job it
 * handed over; this function only talks to the provider and records the
 * answer against the job's lease.
 */
export async function dispatchDueMessages(maxJobs = 50): Promise<DispatchSummary> {
  const supabase = createServiceSupabaseClient();
  const summary: DispatchSummary = { claimed: 0, sent: 0, failed: 0, configuration_failed: 0, retried: 0, unknown: 0, released_campaigns: 0 };

  const { data: released } = await supabase.rpc("hanafy_campaigns_release_due");
  summary.released_campaigns = typeof released === "number" ? released : 0;

  const { data, error } = await supabase.rpc("hanafy_message_jobs_claim", { max_jobs: maxJobs, lease_seconds: 120 });
  if (error) throw new Error(`Could not claim message jobs: ${error.message}`);
  const jobs = (Array.isArray(data) ? data : []) as ClaimedJob[];
  summary.claimed = jobs.length;

  for (const job of jobs) {
    const segments = smsSegments(job.body);
    let outcome: "sent" | "retry" | "failed" | "unknown";
    let providerMessageId: string | null = null;
    let errorText: string | null = null;
    let configurationFailed = false;

    const productionError = liveSendingError(job);
    if (productionError) {
      // A message is successful only when AWS accepts it.  Do not give staff
      // a simulated-success result when the platform is not ready to deliver.
      outcome = "failed";
      errorText = productionError;
      configurationFailed = true;
    } else {
      const credentials = credentialsFor(job.secret_reference);
      if (!credentials || !job.aws_region) {
        outcome = "failed";
        errorText = "Live sending is on but the connection's AWS credentials or region are missing on the server.";
        configurationFailed = true;
      } else {
        const result = await sendAwsTextMessage({
          region: job.aws_region,
          credentials,
          destination: job.recipient,
          body: job.body,
          originationIdentity: job.origination_identity,
          messageType: job.message_type,
        });
        if (result.ok) {
          outcome = "sent";
          providerMessageId = result.messageId;
        } else {
          outcome = result.unknown ? "unknown" : result.retryable ? "retry" : "failed";
          errorText = result.error;
        }
      }
    }

    const { error: finishError } = await supabase.rpc("hanafy_message_job_finish", {
      target_job_id: job.job_id,
      target_lease: job.lease_token,
      outcome,
      provider_message_value: providerMessageId,
      error_value: errorText,
      simulated_value: false,
      segments_value: segments,
    });
    if (finishError) logger.error("messaging.finish_failed", new Error(finishError.message), { job_id: job.job_id });

    if (outcome === "sent") summary.sent += 1;
    else if (outcome === "retry") summary.retried += 1;
    else if (outcome === "unknown") summary.unknown += 1;
    else {
      summary.failed += 1;
      if (configurationFailed) summary.configuration_failed += 1;
    }
    if (errorText) logger.warn("messaging.send_problem", { job_id: job.job_id, workspace_id: job.workspace_id, outcome, error: errorText.slice(0, 200) });
  }
  return summary;
}
