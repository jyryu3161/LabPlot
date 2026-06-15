import { expect, test } from '@playwright/test';

test('public gallery exposes template actions', async ({ page }) => {
  await page.goto('/gallery');
  await expect(page.getByRole('heading', { name: 'Gallery' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use as template' }).first()).toBeVisible();
});

test('authenticated user can open the gallery template flow', async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated flow');

  await page.goto('/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/projects/);

  await page.goto('/gallery');
  await page.getByRole('link', { name: 'Use as template' }).first().click();
  await expect(page.getByText('Selected template')).toBeVisible();
  await expect(page.getByText('1. Choose project')).toBeVisible();
  await expect(page.getByText('2. Upload data for this template')).toBeVisible();
});
