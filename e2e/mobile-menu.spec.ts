import { test, expect } from "@playwright/test";
for (const width of [320,375,393,430,600]) {
  test(`phone menu fits at ${width}px with contained photos and readable item controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => localStorage.setItem("wayne-order-details-v1",JSON.stringify({ fulfillment:"pickup", first_name:"Synthetic" })));
    await page.goto("/menu");
    await expect(page.locator(".menu-product").first()).toBeVisible();
    await expect(page.getByRole("button", { name:"Open navigation",exact:true })).toBeVisible();
    const bounds = await page.evaluate(() => {
      const card = document.querySelector(".menu-product")!;
      const photo = card.querySelector(".menu-photo")!.getBoundingClientRect();
      const content = card.querySelector(".menu-product-content")!.getBoundingClientRect();
      const header = document.querySelector(".site-header")!.getBoundingClientRect();
      return { overflow:document.documentElement.scrollWidth > innerWidth, photoWidth:photo.width, photoHeight:photo.height, photoRight:photo.right, contentLeft:content.left, headerHeight:header.height, controls:[...card.querySelectorAll("button")].map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})) };
    });
    expect(bounds.overflow).toBe(false);
    expect(bounds.photoWidth).toBeLessThanOrEqual(96);
    expect(bounds.photoHeight).toBeLessThanOrEqual(96);
    expect(bounds.photoRight).toBeLessThanOrEqual(bounds.contentLeft + 10);
    expect(bounds.headerHeight).toBeLessThan(100);
    expect(bounds.controls.every(control=>control.height>=44)).toBe(true);
    await page.screenshot({ path:`test-results/mobile-menu-list-${width}.png`,fullPage:true });
    await page.locator(".menu-product").first().getByRole("button", { name:"Customize & add" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/mobile-menu-${width}.png`,fullPage:true });
  });
}
