import { describe, expect, it } from "vitest";
import { classifyAwsError, credentialsFor, liveSendingAllowed, smsSegments } from "./aws-sms";
import { isTrustedSnsUrl, readSmsPayload, snsStringToSign, type SnsMessage } from "./sns";

describe("platform messaging helpers", () => {
  it("reads AWS credentials only from the connection's own env prefix", () => {
    const env = { WAYNES_SMS_ACCESS_KEY_ID: "AKIA1", WAYNES_SMS_SECRET_ACCESS_KEY: "secret1", OTHER_ACCESS_KEY_ID: "AKIA2", OTHER_SECRET_ACCESS_KEY: "secret2" } as unknown as NodeJS.ProcessEnv;
    expect(credentialsFor("env:WAYNES_SMS", env)).toEqual({ accessKeyId: "AKIA1", secretAccessKey: "secret1" });
    expect(credentialsFor("env:MISSING", env)).toBeNull();
    expect(credentialsFor(null, env)).toBeNull();
    expect(credentialsFor("WAYNES_SMS", env)).toBeNull();
  });

  it("needs both the connection switch and the server switch to send for real", () => {
    expect(liveSendingAllowed({ live_sending: true }, { MESSAGING_LIVE_SEND: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(liveSendingAllowed({ live_sending: true }, {} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(liveSendingAllowed({ live_sending: false }, { MESSAGING_LIVE_SEND: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("retries only what AWS says is temporary", () => {
    expect(classifyAwsError(400, "ThrottlingException", "slow down")).toMatchObject({ ok: false, retryable: true });
    expect(classifyAwsError(503, null, "down")).toMatchObject({ retryable: true });
    expect(classifyAwsError(400, "com.amazonaws#ValidationException", "bad number")).toMatchObject({ retryable: false, error: "ValidationException: bad number" });
    expect(classifyAwsError(400, "ConflictException", "opted out")).toMatchObject({ retryable: false });
  });

  it("counts SMS segments", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("🍕".repeat(70))).toBe(1);
    expect(smsSegments("🍕".repeat(71))).toBe(2);
  });

  it("trusts only SNS certificate hosts", () => {
    expect(isTrustedSnsUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem")).toBe(true);
    expect(isTrustedSnsUrl("http://sns.us-east-1.amazonaws.com/x.pem")).toBe(false);
    expect(isTrustedSnsUrl("https://sns.us-east-1.amazonaws.com.evil.test/x.pem")).toBe(false);
    expect(isTrustedSnsUrl("https://evil.test/sns.us-east-1.amazonaws.com")).toBe(false);
  });

  it("builds the SNS string to sign in AWS's order", () => {
    const message = { Type: "Notification", MessageId: "m1", TopicArn: "arn:t", Message: "hi", Timestamp: "2026-01-01T00:00:00Z", SignatureVersion: "1", Signature: "x", SigningCertURL: "https://sns.us-east-1.amazonaws.com/c.pem" } satisfies SnsMessage;
    expect(snsStringToSign(message)).toBe("Message\nhi\nMessageId\nm1\nTimestamp\n2026-01-01T00:00:00Z\nTopicArn\narn:t\nType\nNotification\n");
  });

  it("recognises inbound texts and delivery receipts", () => {
    expect(readSmsPayload(JSON.stringify({ originationNumber: "+15085551000", destinationNumber: "+15136764597", messageBody: "STOP", inboundMessageId: "in-1" })))
      .toEqual({ kind: "inbound", value: { originationNumber: "+15085551000", destinationNumber: "+15136764597", messageBody: "STOP", inboundMessageId: "in-1" } });
    expect(readSmsPayload(JSON.stringify({ messageId: "m-1", messageStatus: "DELIVERED", eventTimestamp: 5 })))
      .toEqual({ kind: "delivery", value: { messageId: "m-1", messageStatus: "DELIVERED", eventId: "m-1:DELIVERED:5" } });
    expect(readSmsPayload("not json")).toEqual({ kind: "unknown" });
  });
});
