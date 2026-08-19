const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const authHeaders = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

test.describe('list card action menus', () => {
  test('figure actions are keyboard-operable and rename stays accessible', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const figuresResponse = await request.get(`${ENV.BASE}/api/figures`, { headers: authHeaders(tokens) });
    expect(figuresResponse.ok(), 'figures fixture request').toBeTruthy();
    const figures = await figuresResponse.json();
    expect(figures.length, 'the QA account needs an existing figure').toBeGreaterThan(0);
    const figure = figures[0];
    const favoriteAction = figure.is_favorite ? 'Remove from saved templates' : 'Save as template';

    await authedPage(page, tokens);
    await page.goto('/figures', { waitUntil: 'domcontentloaded' });
    const trigger = page.getByRole('button', { name: `Figure actions for ${figure.name}`, exact: true }).first();
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    // Keep focus + activation atomic. The list can finish a background query
    // refresh between separate focus() and keyboard calls, replacing the card
    // node before Enter is delivered even though the menu itself is sound.
    await trigger.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: `Figure actions for ${figure.name}`, exact: true });
    const menuItems = menu.getByRole('menuitem');
    await expect(menu).toBeVisible();
    await expect(menuItems).toHaveText(['Rename', favoriteAction, 'Duplicate', 'Delete']);
    await expect(menu.getByRole('separator')).toHaveCount(1);
    await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: favoriteAction, exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const renameInput = page.getByRole('textbox', { name: `New name for ${figure.name}`, exact: true });
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toBeFocused();
    await expect(renameInput).toHaveValue(figure.name);
    await page.keyboard.press('Escape');
    await expect(renameInput).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    const dialogPromise = page.waitForEvent('dialog');
    const deleteClickPromise = menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toBe(`Delete ${figure.name}?`);
    await dialog.dismiss();
    await deleteClickPromise;
    await expect(trigger).toBeVisible();
  });

  test('canvas actions expose rename and duplicate before separated delete with keyboard focus', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const canvasesResponse = await request.get(`${ENV.BASE}/api/canvases`, { headers: authHeaders(tokens) });
    expect(canvasesResponse.ok(), 'canvases fixture request').toBeTruthy();
    const canvases = await canvasesResponse.json();
    expect(canvases.length, 'the QA account needs an existing canvas').toBeGreaterThan(0);
    const canvas = canvases[0];

    await authedPage(page, tokens);
    await page.goto('/canvases', { waitUntil: 'domcontentloaded' });
    const trigger = page.getByRole('button', { name: `Canvas actions for ${canvas.name}`, exact: true }).first();
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    await trigger.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: `Canvas actions for ${canvas.name}`, exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Duplicate', 'Delete']);
    await expect(menu.getByRole('separator')).toHaveCount(1);
    await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const renameInput = page.getByRole('textbox', { name: `New name for ${canvas.name}`, exact: true });
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toBeFocused();
    await expect(renameInput).toHaveValue(canvas.name);
    await page.keyboard.press('Escape');
    await expect(renameInput).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    const dialogPromise = page.waitForEvent('dialog');
    const deleteClickPromise = menu.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const dialog = await dialogPromise;
    expect(dialog.message()).toBe(`Delete canvas "${canvas.name}"?`);
    await dialog.dismiss();
    await deleteClickPromise;
    await expect(trigger).toBeVisible();
  });
});
