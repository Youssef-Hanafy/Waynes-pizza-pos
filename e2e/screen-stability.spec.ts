import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const base="https://waynes-pos-staging.vercel.app";
function staging() { expect(process.env.E2E_RUN_STAGING).toBe("1");expect(process.env.E2E_BASE_URL).toBe(base);expect(process.env.E2E_POS_STORAGE_STATE).toBeTruthy(); }

test("a second POS tab cannot interrupt the owning register",async({browser})=>{
 staging();const context=await browser.newContext({storageState:process.env.E2E_POS_STORAGE_STATE});
 try{
  const first=await context.newPage();await first.goto("/pos");await expect(first.getByRole("button",{name:"Walk-in At the counter",exact:true})).toBeVisible();
  await first.getByRole("button",{name:"Walk-in At the counter",exact:true}).click();
  const second=await context.newPage();await second.goto("/pos");await expect(second.getByRole("heading",{name:"Waiting for this register"})).toBeVisible();
  await expect(first.getByRole("button",{name:new RegExp(process.env.E2E_MENU_ITEM??"Staging Supreme Pizza")})).toBeVisible();
  await expect(second.getByRole("button",{name:/Current Order|New Order/})).toHaveCount(0);
  await first.close();await expect(second.getByRole("heading",{name:"Waiting for this register"})).not.toBeVisible();
  await expect(second.getByRole("button",{name:/Current Order|New Order/})).toBeVisible();
 }finally{await context.close();}
});

test("a future deployment waits for an open order and preserves its saved draft",async({browser,request})=>{
 staging();test.setTimeout(90000);
 const current=await (await request.get("/api/version")).json();
 const context=await browser.newContext({storageState:process.env.E2E_POS_STORAGE_STATE,serviceWorkers:"block"});
 try{
  const page=await context.newPage();await page.goto("/pos");
  await page.getByRole("button",{name:"Walk-in At the counter",exact:true}).click();
  await page.getByRole("button",{name:new RegExp(process.env.E2E_MENU_ITEM??"Staging Supreme Pizza")}).click();
  await page.getByRole("dialog").getByRole("button",{name:/^Add to ticket/}).click();
  await expect(page.getByRole("button",{name:/Take payment ·/})).toBeVisible();
  await page.route("**/api/version?**",route=>route.fulfill({json:{...current,build:"future-build",builtAt:new Date(Date.parse(current.builtAt)+60000).toISOString()}}));
  let navigations=0;page.on("framenavigated",frame=>{if(frame===page.mainFrame())navigations++;});
  await page.clock.install();await page.clock.fastForward(65000);
  await expect(page.getByText("Update available · waiting for safe idle")).toBeVisible();
  await page.clock.fastForward(65000);
  expect(navigations).toBe(0);
  await expect(page.getByRole("button",{name:/Take payment ·/})).toBeVisible();
  expect(await page.evaluate(()=>Object.entries(localStorage).some(([key,value])=>key.includes("pos-drafts.v2")&&value.includes('"cart":[{')))).toBe(true);
 }finally{await context.close();}
});

test("real alias transition updates only after idle and confirms the new build without looping",async({browser})=>{
 staging();test.setTimeout(360000);
 const dir=process.env.E2E_UPDATE_CONTROL_DIR;expect(dir,"Operator must coordinate a second exact-commit staging build").toBeTruthy();
 const context=await browser.newContext({storageState:process.env.E2E_POS_STORAGE_STATE});
 try{
  const page=await context.newPage();await page.goto("/pos");await expect(page.getByRole("button",{name:"Walk-in At the counter",exact:true})).toBeVisible();
  const from=await page.locator('meta[name="wayne-build"]').getAttribute("content");expect(from).toBeTruthy();
  await page.getByRole("button",{name:"Walk-in At the counter",exact:true}).click();
  await page.getByRole("button",{name:new RegExp(process.env.E2E_MENU_ITEM??"Staging Supreme Pizza")}).click();
  await page.getByRole("dialog").getByRole("button",{name:/^Add to ticket/}).click();
  writeFileSync(join(dir!,"browser-ready.json"),JSON.stringify({from}));
  await expect.poll(()=>existsSync(join(dir!,"target.json")),{timeout:240000,intervals:[2000]}).toBe(true);
  const target=JSON.parse(readFileSync(join(dir!,"target.json"),"utf8")) as {build:string};expect(target.build).not.toBe(from);
  // Real version response from the newly deployed alias, with a live order still open.
  await page.evaluate(()=>window.dispatchEvent(new Event("online")));
  await expect(page.getByText("Update available · waiting for safe idle")).toBeVisible();
  expect(await page.locator('meta[name="wayne-build"]').getAttribute("content")).toBe(from);
  await expect(page.getByRole("button",{name:/Take payment ·/})).toBeVisible();
  // Staff explicitly abandons only this synthetic unsent order through the normal UI.
  await page.getByRole("button",{name:"＋ New order",exact:true}).click();
  await expect(page.getByRole("button",{name:"Walk-in At the counter",exact:true})).toBeVisible();
  await expect.poll(async()=>page.locator('meta[name="wayne-build"]').getAttribute("content"),{timeout:95000,intervals:[1000]}).toBe(target.build);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem("wayne.pos.update-journal.v1")??"{}").confirmed),{timeout:10000}).toBe(true);
  const journal=await page.evaluate(()=>JSON.parse(sessionStorage.getItem("wayne.pos.update-journal.v1")??"{}"));expect(journal.target).toBe(target.build);expect(journal.attempts).toBe(1);
  await page.evaluate(()=>{window.dispatchEvent(new Event("online"));window.dispatchEvent(new Event("pageshow"));});
  await page.getByRole("button",{name:"More",exact:true}).click();
  await expect(page.getByText(/current: This register is on the verified live build/)).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem("wayne.pos.update-journal.v1")??"{}").attempts)).toBe(1);
  writeFileSync(join(dir!,"browser-confirmed.json"),JSON.stringify({from,to:target.build,journal}));
 }finally{await context.close();}
});
