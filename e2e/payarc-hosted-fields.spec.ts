import { expect, test } from "@playwright/test";
import { payarcFieldsDocument } from "../src/lib/payments/payarc-fields";

test("Payarc hosted form isolates SDK globals and returns only a payment token", async ({ page }) => {
  await page.route("https://waynes.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.route("https://testportal.payarc.net/js/iframeprocess.js", (route) => route.fulfill({ contentType: "application/javascript", body: `
    const sdkGlobal = 'isolated';
    function initPayarcTokenizer(clientId, settings) {
      if (clientId !== 'public-client') throw new Error('Wrong client');
      window.settings = settings;
      const frame = document.createElement('iframe');
      frame.srcdoc = '<input aria-label="Provider card number">';
      document.getElementById('number').appendChild(frame);
      document.getElementById('tokenize').dataset.uuid = 'provider-session';
    }
    function getPayarcToken() { window.settings.TOKEN_CALLBACK.success({ response: JSON.stringify({ token: 'one-use-token' }) }); }
  ` }));
  await page.goto("https://waynes.test/");
  await page.evaluate((html) => {
    const frame = document.createElement("iframe"); frame.title = "Payarc form"; frame.srcdoc = html; document.body.appendChild(frame);
    (window as unknown as { messages: unknown[] }).messages = [];
    window.addEventListener("message", (event) => { if (event.source === frame.contentWindow) (window as unknown as { messages: unknown[] }).messages.push(event.data); });
  }, payarcFieldsDocument("public-client", "sandbox", "test-channel", "https://waynes.test"));
  await expect.poll(() => page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ channel: "test-channel", type: "ready" });
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ channel: "wrong-channel", type: "tokenize" }, location.origin));
  expect(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toHaveLength(1);
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ channel: "test-channel", type: "tokenize" }, location.origin));
  await expect.poll(() => page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ channel: "test-channel", type: "token", token: "one-use-token" });
  expect(await page.evaluate(() => typeof (window as unknown as { initPayarcTokenizer?: unknown }).initPayarcTokenizer)).toBe("undefined");
});
