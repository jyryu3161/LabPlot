import { expect, test } from '@playwright/test';

test('header shows project invitation badge and accepts invitation', async ({ page }) => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  test.skip(!email || !password, 'Set E2E_EMAIL and E2E_PASSWORD to run authenticated flow');

  let accepted = false;
  let pending = true;
  await page.route('**/api/projects/invitations', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(pending ? [{
        id: '11111111-1111-4111-8111-111111111111',
        project_id: '22222222-2222-4222-8222-222222222222',
        project_name: 'Shared biology project',
        project_description: 'Mock invitation',
        owner_name: 'Project Owner',
        owner_email: 'owner@example.com',
        role: 'editor',
        created_at: new Date().toISOString(),
      }] : []),
    });
  });
  await page.route('**/api/projects/invitations/*/accept', async (route) => {
    accepted = true;
    pending = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: '22222222-2222-4222-8222-222222222222',
        owner_id: '33333333-3333-4333-8333-333333333333',
        name: 'Shared biology project',
        description: 'Mock invitation',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        role: 'editor',
        collaborators: [],
      }),
    });
  });

  await page.goto('/login');
  await page.getByLabel('Email').fill(email!);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/projects/);

  await page.getByRole('button', { name: /Project invitations: 1 pending/ }).click();
  const menu = page.getByTestId('header-invitations-menu');
  await expect(menu.getByText('Shared biology project')).toBeVisible();
  await menu.getByRole('button', { name: /Accept/ }).click();
  await expect.poll(() => accepted).toBe(true);
});
