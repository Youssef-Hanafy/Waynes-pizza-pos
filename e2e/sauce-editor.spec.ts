import { expect, test } from "@playwright/test";
const id = "79000000-0000-4000-8000-0000000000e1";
test("saves shared Marinara pricing and this item's size allowances through the back office, then prices it on POS", async ({page}) => {
  await page.goto("/admin/menu/sauces");
  await page.getByRole("textbox", {name:"Marinara shared price",exact:true}).fill("0.85");
  await page.getByRole("button", {name:"Save shared sauce prices",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("Shared prices saved");
  await page.goto(`/admin/menu/items/${id}`);
  await expect(page.getByRole("spinbutton", {name:"One Size free portions",exact:true})).toHaveValue("2");
  await page.getByRole("spinbutton", {name:"One Size free portions",exact:true}).fill("1");
  await page.getByRole("button", {name:"Save menu item",exact:true}).click();
  await expect(page).toHaveURL(/admin\/menu\?saved=1/);
  await page.goto(`/admin/menu/items/${id}`);
  for (const [size, free] of [["Small","1"],["One Size","1"],["Large","2"]]) {
    await expect(page.getByRole("spinbutton", {name:`${size} free portions`,exact:true})).toHaveValue(free);
  }
  expect(await page.getByRole("spinbutton", {name:"One Size free portions",exact:true}).evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:"test-results/item-allowances-editor.png",fullPage:true});
  await page.goto(`/pos/${id}`);
  await page.getByRole("button", {name:/^One Size/}).click();
  await expect(page.getByText(/1 included on a One Size/)).toBeVisible();
  await page.getByRole("button", {name:"Add Marinara",exact:true}).click();
  await expect(page.getByRole("button", {name:/Add to ticket.*10.85/})).toBeVisible();
  await page.getByRole("button", {name:/^Large/}).click();
  await expect(page.getByText(/2 included on a Large/)).toBeVisible();
  await expect(page.getByRole("button", {name:/Add to ticket.*10.00/})).toBeVisible();
  await page.getByRole("button", {name:"Add Marinara",exact:true}).click();
  await page.getByRole("button", {name:/Add to ticket.*10.85/}).click();
  await expect(page.getByRole("status")).toHaveText("Database order price: 1085");
});

test("turns off shared sauce pricing for one menu item and charges its own size price", async ({ page }) => {
  await page.goto(`/admin/menu/items/${id}`);
  const sharedPrice = page.getByRole("checkbox", { name: "Use shared price for Marinara" });
  await expect(sharedPrice).toBeChecked();
  await sharedPrice.uncheck();
  await page.getByRole("textbox", { name: "Default price change ($)", exact: true }).fill("1.25");
  await page.getByRole("textbox", { name: "Large ($)", exact: true }).fill("1.75");
  await page.getByRole("button", { name: "Save menu item", exact: true }).click();
  await expect(page).toHaveURL(/admin\/menu\?saved=1/);
  await page.goto(`/admin/menu/items/${id}`);
  await expect(sharedPrice).not.toBeChecked();
  await expect(page.getByRole("textbox", { name: "Default price change ($)", exact: true })).toHaveValue("1.25");
  await expect(page.getByRole("textbox", { name: "Large ($)", exact: true })).toHaveValue("1.75");
  await page.goto(`/pos/${id}`);
  await page.getByRole("button", { name: /^Large/ }).click();
  const addMarinara = page.getByRole("button", { name: "Add Marinara", exact: true });
  await addMarinara.click();
  await expect(page.getByRole("button", { name: /Add to ticket.*10.00/ })).toBeVisible();
  await addMarinara.click();
  await page.getByRole("button", { name: /Add to ticket.*11.75/ }).click();
  await expect(page.getByRole("status")).toHaveText("Database order price: 1175");
});
