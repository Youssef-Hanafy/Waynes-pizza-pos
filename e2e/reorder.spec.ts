import { test, expect, type Page, type Locator } from '@playwright/test';
async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wayne-pos-keyboard','on'));
  await page.route('**/*',async r => {
    const url = new URL(r.request().url());
    if(url.hostname !== '127.0.0.1') return r.abort();
    if(url.pathname === '/pos-sw.js') return r.abort();
    if(!url.pathname.startsWith('/api/')) return r.continue();
    const arrays=['/api/pos/open-orders','/api/pos/drafts','/api/pos/tip-drafts','/api/pos/terminal','/api/pos/customers','/api/pos/discounts'];
    const body = arrays.includes(url.pathname) ? [] : url.pathname==='/api/version' ? {build:'audit_A',commit:'086c5d6',builtAt:'2026-11-01T00:00:00Z',contract:1,minimumClient:0,minimumBridge:1} : url.pathname==='/api/pos/delivery' ? {waiting:[],drivers:[{driver_id:'00000000-0000-4000-8000-000000009999',name:'Fixture driver',clocked_in:true,orders:[]}]} : url.pathname==='/api/pos/day-orders' ? {day:'2026-11-01',orders:[]} : url.pathname==='/api/pos/delivery/day-report' ? {day:'2026-11-01',timezone:'America/New_York',drivers:[]} : {ok:true,events:[],blockers:[],build:'audit_A'};
    return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/pos');
  await expect(page.getByRole('navigation',{name:'POS sections'})).toBeVisible();
}

async function menu(page: Page) {
  await boot(page);
  await page.getByRole('button', { name: 'Jump to take order →' }).click();
}
async function holdMove(page: Page, source: Locator, destination: Locator) {
  const a = (await source.boundingBox())!, b = (await destination.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.up();
}
test('hold rearranges real menu tiles, saves across reload, and never opens an item', async ({ page }) => {
  await menu(page);
  const grid = page.getByLabel('Menu items', { exact: true });
  const first = grid.locator('[data-reorder-id]').nth(0);
  const original = await first.getAttribute('data-reorder-id');
  await holdMove(page, first, grid.locator('[data-reorder-id]').nth(2));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(grid.locator('[data-reorder-id]').nth(2)).toHaveAttribute('data-reorder-id', original!);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(grid).toBeVisible();
  await expect(grid.locator('[data-reorder-id]').nth(2)).toHaveAttribute('data-reorder-id', original!);
  await grid.locator('[data-reorder-id]').nth(2).tap();
  await expect(page.getByRole('dialog')).toBeVisible();
});
test('modifier reordering preserves portions, half controls, and layout on another item', async ({ page }) => {
  await menu(page);
  await page.getByRole('button', { name: 'Dinners', exact: true }).tap();
  await page.getByRole('button', { name: 'Dinners 1 $12.00', exact: true }).tap();
  const cards = page.getByRole('dialog').locator('[data-reorder-id]');
  const original = await cards.first().getAttribute('data-reorder-id');
  const before = await page.getByRole('button', { name: /Add to ticket/ }).textContent();
  await holdMove(page, cards.first().locator('strong').first(), cards.nth(1).locator('strong').first());
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(cards.nth(1)).toHaveAttribute('data-reorder-id', original!);
  await expect(page.getByRole('button', { name: /Add to ticket/ })).toHaveText(before!);
  const add = cards.nth(1).getByRole('button', { name: /^Add / });
  if (await add.isEnabled()) { await add.tap(); await expect(cards.nth(1)).toHaveAttribute('data-state', 'on'); }
  await page.getByRole('button', { name: 'Close item' }).tap();
  await page.getByRole('button', { name: 'Dinners 2 $12.00', exact: true }).tap();
  await expect(cards.nth(1)).toHaveAttribute('data-reorder-id', original!);
});
test('real touch hold and drag saves, a swipe does not activate, and touchcancel rolls back', async ({ page, context }) => {
  await menu(page);
  const tiles = page.getByLabel('Menu items', { exact: true }).locator('[data-reorder-id]');
  const original = await tiles.first().getAttribute('data-reorder-id');
  const a = (await tiles.first().boundingBox())!, b = (await tiles.nth(2).boundingBox())!;
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(tiles.nth(2)).toHaveAttribute('data-reorder-id', original!);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y + 30 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(650);
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(tiles.nth(2)).toHaveAttribute('data-reorder-id', original!);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
});
