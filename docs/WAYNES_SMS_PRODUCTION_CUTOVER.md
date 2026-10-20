# Wayne's SMS Production Cutover

## What this enables

After this checklist is complete, campaigns created in Wayne's Marketing page
are delivered through AWS End User Messaging SMS. A message is counted as sent
only after AWS accepts it. Missing production configuration creates a visible
failed message record; the application does not simulate a send.

## Required access

This requires the AWS account that owns Wayne's existing SMS sender
`+1 513-676-4597` and the production deployment's environment-variable
settings. The existing sender credentials are not in this repository and must
be transferred through the hosting provider's secret manager, not chat or git.

## One-time production setup

1. In AWS End User Messaging, verify that Wayne's sender is active, production
   access is granted, and its 10DLC registration is approved. Keep the sender
   as the same number already used by Wayne's CRM.
2. Create or use a least-privilege AWS principal with only
   `sms-voice:SendTextMessage` for Wayne's sender. In the production hosting
   environment, set `WAYNES_SMS_ACCESS_KEY_ID`,
   `WAYNES_SMS_SECRET_ACCESS_KEY`, `MESSAGING_LIVE_SEND=true`, and a unique
   32+ character `MESSAGING_DISPATCH_TOKEN` (or `CRON_SECRET` for Vercel
   Cron). Set
   `MESSAGING_SNS_TOPIC_ARNS` to the approved inbound/delivery SNS topic ARN.
3. Configure an authenticated scheduler to call
   `POST https://<production-host>/api/messaging/dispatch` once per minute with
   `Authorization: Bearer <MESSAGING_DISPATCH_TOKEN>`. Confirm it returns a
   JSON dispatch summary. On Vercel, a production cron calls this route with
   `CRON_SECRET` automatically; use a plan that supports minute-level cron, or
   keep the authenticated external scheduler.
4. In AWS, route two-way SMS and delivery events for the Wayne's sender to the
   approved SNS topic and subscribe that topic to
   `https://<production-host>/api/messaging/inbound`. Confirm the subscription.
5. Pause Wayne's live automations in the old Hanafy CRM. This is mandatory: the
   old CRM currently owns the sender, and leaving both systems live can send
   customers duplicate messages.
6. In Platform Admin → Wayne's → Messaging, set the connection to `active`,
   choose `Hanafy Platform`, set `Live (real texts)`, enter
   `env:WAYNES_SMS` as the credential reference, and record the sender's AWS
   identity/ARN. Confirm the audited warning.
7. Send one staff-only test message, confirm it is accepted by AWS and that a
   delivery receipt appears. Then send a small, consented campaign and verify
   sent, delivered, failed, and STOP handling before using the full audience.

## Do not skip

- Do not disable consent or STOP suppression. They are production safeguards,
  not test behavior.
- Do not switch the old CRM bridge off before steps 1–4 work. That would stop
  Wayne's existing live campaign delivery.
- Do not put AWS keys or dispatcher tokens in `.env` files committed to git.
