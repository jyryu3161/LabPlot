const { test, expect } = require('@playwright/test');
const { ENV, apiLogin, authedPage } = require('../helpers');

const DATASET_ID = process.env.QA_DATASET;
const authHeaders = (tokens) => ({ Authorization: `Bearer ${tokens.access_token}` });

test.describe('AI recommendation mapping safety', () => {
  test.skip(!DATASET_ID, 'set QA_DATASET to the recommendation audit dataset');

  test('a high-fit recommendation fills every required mapping before Generate is enabled', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    const headers = authHeaders(tokens);
    const [recommendationsResponse, plotTypesResponse] = await Promise.all([
      request.get(`${ENV.BASE}/api/datasets/${DATASET_ID}/recommendations`, { headers }),
      request.get(`${ENV.BASE}/api/plot-types`, { headers }),
    ]);
    expect(recommendationsResponse.ok(), 'cached recommendation request').toBeTruthy();
    expect(plotTypesResponse.ok(), 'plot type request').toBeTruthy();
    const recommendations = await recommendationsResponse.json();
    const plotTypes = await plotTypesResponse.json();
    const suggestion = recommendations.suggestions.find((item) => item.plot_type === 'grouped_bar');
    expect(suggestion, 'fixture needs a grouped-bar recommendation').toBeTruthy();
    expect(suggestion.mapping_complete).toBe(true);
    expect(suggestion.missing_required_mappings).toEqual([]);
    expect(suggestion.suggested_mapping).toMatchObject({
      x: 'Time_h',
      y: 'Expression',
      group: 'Genotype',
    });

    const definition = plotTypes.plot_types.find((item) => item.type === suggestion.plot_type);
    expect(definition, 'grouped_bar definition').toBeTruthy();

    await authedPage(page, tokens);
    await page.goto(`/datasets/${DATASET_ID}?tab=visualize`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /2\. AI recommendations/ }).click();
    const card = page.getByRole('button').filter({ hasText: suggestion.title }).first();
    await expect(card).toContainText('Data structure fit');
    await expect(card).toContainText(`${Math.round(suggestion.scores.overall * 100)}%`);
    await card.click();

    await expect(page.getByTestId('chart-type-select')).toHaveValue('grouped_bar');
    for (const field of definition.required) {
      const expected = suggestion.suggested_mapping[field.key];
      expect(expected, `${field.label} should be present in the recommendation`).toBeTruthy();
      await expect(page.getByRole('combobox', { name: field.label, exact: true })).toHaveValue(expected);
    }
    await expect(page.getByRole('button', { name: 'Generate figure', exact: true })).toBeEnabled();
  });

  test('recommendation API exposes component scores and ranks explicit replicate intent by overall', async ({ request }) => {
    const tokens = await apiLogin(request);
    const headers = authHeaders(tokens);
    const response = await request.get(`${ENV.BASE}/api/datasets/${DATASET_ID}/recommendations`, { headers });
    expect(response.ok(), 'cached recommendation request').toBeTruthy();
    const payload = await response.json();
    expect(payload.suggestions.length).toBeGreaterThan(0);

    for (const suggestion of payload.suggestions) {
      expect(Object.keys(suggestion.scores).sort()).toEqual([
        'data_structure_fit',
        'overall',
        'statistical_suitability',
        'user_intent_match',
      ]);
      for (const value of Object.values(suggestion.scores)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(suggestion.score).toBe(suggestion.scores.overall);
    }

    const individualSuggestions = payload.suggestions.filter((item) => item.intent?.show_individual_observations);
    if (individualSuggestions.length > 0) {
      expect(payload.suggestions[0].intent?.show_individual_observations).toBe(true);
      expect(payload.suggestions[0].scores.user_intent_match).toBeGreaterThanOrEqual(0.9);
    }
  });

  test('unsupported individual-observation recommendations cannot be silently applied', async ({ page, request }) => {
    const tokens = await apiLogin(request);
    await authedPage(page, tokens);
    await page.route(`**/api/datasets/${DATASET_ID}/recommendations`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cached: true,
          suggestions: [{
            plot_type: 'line',
            title: 'Individual replicate trajectories',
            score: 0.4,
            scores: {
              data_structure_fit: 0.95,
              user_intent_match: 0.25,
              statistical_suitability: 0.4,
              overall: 0.4,
            },
            suggested_mapping: { x: 'Time_h', y: 'Expression', group: 'Genotype' },
            suggested_options: {},
            mapping_complete: true,
            missing_required_mappings: [],
            intent: {
              show_individual_observations: true,
              individual_observation_support: {
                status: 'selection_required',
                mode: 'raw_trajectories',
                reason: 'renderer_cannot_group_by_replicate',
              },
              line_policy: {
                replicate_id_column: 'Subject_ID',
                raw_trajectory_grouping: 'not_supported_by_renderer',
                same_time_replicates: 'do_not_connect_without_aggregation',
                summary_mode: 'selection_required',
                error_summary: 'none',
                support_status: 'selection_required',
                blocking_reason: 'renderer_cannot_group_by_replicate',
                requires_confirmation: true,
              },
            },
            source: 'ai',
          }, {
            plot_type: 'bar',
            title: 'Summary-only bars',
            score: 0.3,
            scores: {
              data_structure_fit: 0.9,
              user_intent_match: 0.15,
              statistical_suitability: 0.5,
              overall: 0.3,
            },
            suggested_mapping: { x: 'Genotype', y: 'Expression' },
            suggested_options: { stat: 'mean' },
            mapping_complete: true,
            missing_required_mappings: [],
            intent: {
              show_individual_observations: true,
              individual_observation_support: {
                status: 'unsupported',
                mode: 'summary_only',
                reason: 'renderer_does_not_show_individual_observations',
              },
            },
            source: 'ai',
          }],
        }),
      });
    });

    await page.goto(`/datasets/${DATASET_ID}?tab=visualize`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /2\. AI recommendations/ }).click();
    const card = page.getByRole('button').filter({ hasText: 'Individual replicate trajectories' }).first();
    await expect(card).toHaveAttribute('aria-disabled', 'true');
    await expect(card).toContainText('this line renderer cannot group by it');
    await expect(card).toContainText('Choose a supported points + summary chart');
    await card.focus();
    await expect(card).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-sonner-toast]')).toContainText('cannot be applied safely');

    const summaryOnlyCard = page.getByRole('button').filter({ hasText: 'Summary-only bars' }).first();
    await expect(summaryOnlyCard).toHaveAttribute('aria-disabled', 'true');
    await expect(summaryOnlyCard).toContainText('cannot render the requested individual observations');
    await summaryOnlyCard.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'cannot render the requested individual observations' })).toBeVisible();
  });
});
