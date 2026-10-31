import { expect,test } from '@playwright/test';
const ids=['418c30cc-344c-4200-917d-0d60c183c77c','5677ccf0-ba1d-41a1-8382-473233f61ea9'];
for(const [index,name] of ['Cheeseburger Dinner','Gyro Dinner'].entries()) {
  test(`${name}: save through actual admin action, reload, POS add and database charge`,async({page})=>{
    await page.goto(`/admin/menu/items/${ids[index]}`);
    await page.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.25');
    await page.getByRole('button',{name:'Save menu item',exact:true}).click();
    await expect(page).toHaveURL(/admin\/menu\?saved=1/);
    await page.goto(`/admin/menu/items/${ids[index]}`);
    await page.getByRole('button',{name:'Save prices only',exact:true}).click();
    await expect(page.getByText('Prices saved to the database.',{exact:true})).toBeVisible();
    await page.reload();await expect(page.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.25');
    await page.goto(`/pos/${ids[index]}`);
    await expect(page.getByRole('button',{name:/Add to ticket.*14.25/})).toBeVisible();
    await page.getByRole('button',{name:/Add to ticket/}).click();
    await expect(page.getByRole('status')).toHaveText('Database order price: 1425');
    await page.evaluate(()=>localStorage.setItem('wayne-order-details-v1',JSON.stringify({fulfillment:'pickup',first_name:'Synthetic'})));
    await page.goto('/menu');
    const card=page.locator('article').filter({hasText:name});
    await expect(card.getByText('$14.25',{exact:true})).toBeVisible();
    await card.getByRole('button',{name:'Customize & add'}).click();
    await expect(page.getByRole('dialog').getByRole('button',{name:/Add.*14.25/})).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:/Add.*14.25/}).click();
  });
}
test('database failure keeps the typed draft and never confirms success; stale register cannot roll back a save',async({browser})=>{
  const a=await browser.newPage(),b=await browser.newPage();
  const path=`/admin/menu/items/${ids[0]}`;
  await a.goto(path);await b.goto(path);
  await a.request.post('http://127.0.0.1:3107/api/control');
  await a.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.26');
  await a.getByRole('button',{name:'Save prices only',exact:true}).click();
  await expect(a.getByRole('main').getByRole('alert')).toHaveText('Injected database write failure');
  await expect(a.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.26');
  await expect(a.getByText('Prices saved to the database.',{exact:true})).not.toBeVisible();
  await a.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.25');
  await a.getByRole('button',{name:'Save prices only',exact:true}).click();
  await expect(a.getByText('Prices saved to the database.',{exact:true})).toBeVisible();
  // A failure after a successful save must not leave the old success notice.
  await a.request.post('http://127.0.0.1:3107/api/control');
  await a.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('14.26');
  await expect(a.getByText('Prices saved to the database.',{exact:true})).not.toBeVisible();
  await a.getByRole('button',{name:'Save prices only',exact:true}).click();
  await expect(a.getByRole('main').getByRole('alert')).toHaveText('Injected database write failure');
  await expect(a.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.26');
  await expect(a.getByText('Prices saved to the database.',{exact:true})).not.toBeVisible();
  await b.getByRole('textbox',{name:'Item price ($)',exact:true}).fill('13.50');
  await b.getByRole('button',{name:'Save prices only',exact:true}).click();
  await expect(b.getByRole('main').getByRole('alert')).toContainText('another register');
  await b.reload();await expect(b.getByRole('textbox',{name:'Item price ($)',exact:true})).toHaveValue('14.25');
  await a.close();await b.close();
});
