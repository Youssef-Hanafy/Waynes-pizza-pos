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
  expect(await page.evaluate(() => (window as unknown as { messages: { type: string }[] }).messages.filter((message) => message.type === "token"))).toHaveLength(0);
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.postMessage({ channel: "test-channel", type: "tokenize" }, location.origin));
  await expect.poll(() => page.evaluate(() => (window as unknown as { messages: unknown[] }).messages)).toContainEqual({ channel: "test-channel", type: "token", token: "one-use-token" });
  expect(await page.evaluate(() => typeof (window as unknown as { initPayarcTokenizer?: unknown }).initPayarcTokenizer)).toBe("undefined");
});

for (const width of [320, 700]) {
  test(`Payarc shows all four fields without inner scrolling at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("https://waynes.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<html><body style="margin:0"></body></html>' }));
    await page.route("https://testportal.payarc.net/js/iframeprocess.js", (route) => route.fulfill({ contentType: "application/javascript", body: `
      function initPayarcTokenizer() {
        const styles = document.getElementById('payarc-styles').textContent;
        for (const host of document.querySelectorAll('[data-payarc]')) {
          const frame = document.createElement('iframe');
          // Provider fields have the browser's 150px default height unless sized explicitly.
          frame.srcdoc = '<style>' + styles + '</style><div class="payarc-container payarc-all"><div class="payarc-row"><div class="payarc-label-container"><label class="payarc-label">' + host.dataset.placeholder + '</label></div><div class="payarc-input-container"><input class="payarc-input" aria-label="' + host.dataset.placeholder + '"></div></div></div>';
          host.appendChild(frame);
        }
      }
    ` }));
    await page.goto("https://waynes.test/");
    await page.evaluate((html) => {
      const frame = document.createElement("iframe");
      frame.title = "Payarc form"; frame.srcdoc = html;
      frame.style.cssText = 'display:block;box-sizing:border-box;width:100%;height:274px;border:1px solid #ddd;border-radius:12px';
      window.addEventListener("message", (event) => {
        if (event.source === frame.contentWindow && event.data.type === "resize") frame.style.height = (event.data.height + 2) + 'px';
      });
      document.body.appendChild(frame);
    }, payarcFieldsDocument("public-client", "sandbox", "layout-channel", "https://waynes.test"));
    const form = page.frameLocator('iframe[title="Payarc form"]');
    for (const [id, label] of [["number", "Card number"], ["expiry", "MM/YY"], ["cvv", "Security code"], ["zip", "Billing ZIP"]]) {
      const input = form.frameLocator('#' + id + ' iframe').getByRole('textbox', { name: label });
      await expect(input).toBeVisible();
      await expect(input).toBeInViewport({ ratio: 1 });
      expect(await input.evaluate((element) => {
        const doc = element.ownerDocument;
        return doc.documentElement.scrollHeight <= doc.documentElement.clientHeight;
      })).toBe(true);
    }
    const outer = page.locator('iframe[title="Payarc form"]');
    await expect.poll(() => outer.evaluate((frame) => {
      const doc = (frame as HTMLIFrameElement).contentDocument!;
      return doc.documentElement.scrollHeight <= doc.documentElement.clientHeight;
    })).toBe(true);
    expect((await outer.boundingBox())!.height).toBeLessThan(300);
    // Provider validation text must also fit, including on narrow phones.
    await form.locator('#status').evaluate((element) => { element.textContent = 'Please check the billing ZIP and security code before submitting your order.'; });
    await expect.poll(() => outer.evaluate((frame) => {
      const doc = (frame as HTMLIFrameElement).contentDocument!;
      return doc.documentElement.scrollHeight <= doc.documentElement.clientHeight;
    })).toBe(true);
    await page.screenshot({ path: '/tmp/waynes-payarc-layout-' + width + '.png' });
  });
}
