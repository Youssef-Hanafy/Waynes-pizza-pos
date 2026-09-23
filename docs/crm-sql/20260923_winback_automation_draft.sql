-- Applied to the Hanafy Media CRM on 2026-09-23 (created id ae807912-d4ed-4895-9d39-9fc1326e53c4).
-- Trigger: Wayne's POS moves a customer into its "30-day inactive" segment
-- (2+ orders, none in 30 days; Wayne's nightly check).  Status is DRAFT:
-- publish it in /admin/sms -> Automations once the wording is approved.
-- The CRM only sends to contacts with SMS consent and no STOP/suppression.
insert into sms_automations (business_id, name, status, trigger, goal, nodes, edges, created_by)
select '2acaf89c-10ad-4b2b-80c9-dc26a54d5c86', '30-day win-back (Wayne''s)', 'draft',
 '{"type":"segment_entered","segment":"a15233f0-7817-4e12-b5e9-e69f24800914"}'::jsonb,
 '{"type":"purchase_completed"}'::jsonb,
 jsonb_build_array(
  jsonb_build_object('id','node-winback-trigger','type','trigger','title','Hasn''t ordered in 30 days','description','Fires when Wayne''s POS moves a regular (2+ orders) into its 30-day inactive segment. Wayne''s nightly check at 1:05 AM decides this.','config',jsonb_build_object('type','segment_entered','segment','a15233f0-7817-4e12-b5e9-e69f24800914')),
  jsonb_build_object('id','node-winback-sms','type','sms','title','Win-back text','description','Only sent to contacts with SMS consent and no STOP.','config',jsonb_build_object('message','{{business_name}}: We miss you, {{first_name}}! Your Wayne''s favorites are a tap away at waynespizzaofworcester.com or call (508) 852-6326. Reply STOP to opt out.'))),
 jsonb_build_array(jsonb_build_object('id','edge-winback','from','node-winback-trigger','to','node-winback-sms')),
 created_by
from sms_automations where id = '66fbf70c-461e-4d73-bb8b-d5c00c87b2a0';
