import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 (request signing), implemented directly so the
 * platform does not pull in the whole AWS SDK for one API call.  Verified
 * against AWS's published signing example in sigv4.test.ts.
 */
export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export type SigV4Request = {
  method: "GET" | "POST";
  host: string;
  path?: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  /** Defaults to now; injectable for tests. */
  date?: Date;
};

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value, "utf8").digest();

export function amzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Returns the headers to send, including Authorization and X-Amz-Date. */
export function signRequest(request: SigV4Request, credentials: SigV4Credentials): Record<string, string> {
  const stamp = amzDate(request.date ?? new Date());
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { ...request.headers, host: request.host, "x-amz-date": stamp };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lookup = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonicalHeaders = names.map((name) => `${name}:${String(lookup.get(name)).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    request.path ?? "/",
    request.query ?? "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(request.body),
  ].join("\n");

  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), request.region), request.service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const { host: _host, ...rest } = headers;
  void _host;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
