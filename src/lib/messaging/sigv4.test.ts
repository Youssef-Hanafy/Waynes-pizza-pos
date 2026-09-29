import { describe, expect, it } from "vitest";
import { amzDate, signRequest } from "./sigv4";

describe("AWS Signature Version 4", () => {
  it("matches AWS's published IAM ListUsers signing example", () => {
    const headers = signRequest(
      {
        method: "GET",
        host: "iam.amazonaws.com",
        path: "/",
        query: "Action=ListUsers&Version=2010-05-08",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
        region: "us-east-1",
        service: "iam",
        date: new Date("2015-08-30T12:36:00Z"),
      },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("formats the AWS date stamp", () => {
    expect(amzDate(new Date("2026-09-28T13:00:05.123Z"))).toBe("20260928T130005Z");
  });
});
