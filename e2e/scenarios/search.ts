import { expect } from '@playwright/test';
import { parseISO } from 'date-fns';
import { installPlaywrightIpc } from '../helpers';
import {
  playwrightBackfillingTraversalStatus,
  playwrightEmptySearchPage,
  playwrightMailAccount,
  playwrightParsedSearchQuery,
  playwrightSearchThreadPage,
  playwrightSearchTotal,
  playwrightZeroSearchTotal,
} from '@/tests/playwright-fixtures';
import { screenshot } from './shared';
import type { ScreenshotScenario } from './shared';

export const searchScenarios: ScreenshotScenario[] = [
  {
    name: 'search field focused',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await page.getByLabel('Search mail').click();
      await page.getByLabel('Search mail').fill('from:anna');
      await screenshot(page, page.getByRole('search'), 'search-field-focused', theme);
    },
  },
  {
    name: 'search keyword suggestions',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, { overrides: { list_accounts: [playwrightMailAccount] } });
      await page.goto('/');
      await page.getByLabel('Search mail').click();
      await page.getByLabel('Search mail').fill('is:');
      await screenshot(
        page,
        page.getByRole('listbox', { name: 'Search suggestions' }),
        'search-keyword-suggestions',
        theme,
      );
    },
  },
  {
    name: 'advanced search panel',
    run: async (page, theme) => {
      await page.clock.setFixedTime(parseISO('2026-08-17T12:00:00'));
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          parse_search_query: playwrightParsedSearchQuery,
        },
      });
      await page.goto('/');
      await page.getByLabel('Search mail').fill('from:anna quarterly');
      await page.getByRole('button', { name: 'Show search options' }).click();
      await expect(page.getByLabel('From')).toHaveValue('anna');
      await page.getByRole('button', { name: 'Custom…' }).click();
      await page.getByRole('button', { name: 'Between' }).click();
      await page.getByRole('button', { name: '4 August 2026', exact: true }).click();
      await page.getByRole('button', { name: '13 August 2026', exact: true }).click();
      await expect(page.getByTestId('date-filter-summary')).toHaveText('4 Aug 2026 – 13 Aug 2026');
      await screenshot(
        page,
        page.getByTestId('advanced-search-panel'),
        'advanced-search-panel',
        theme,
      );
    },
  },
  {
    name: 'select menu',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          parse_search_query: playwrightParsedSearchQuery,
        },
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Show search options' }).click();
      await page.getByLabel('Search in').click();
      await screenshot(page, page.getByRole('listbox'), 'select-menu', theme);
    },
  },
  {
    name: 'search results sidebar row',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          search_threads: playwrightSearchThreadPage,
          search_total: playwrightSearchTotal,
        },
      });
      await page.goto('/');
      await page.getByLabel('Search mail').fill('from:anna');
      await page.getByLabel('Search mail').press('Enter');
      await screenshot(page, page.getByTestId('search-results-row'), 'search-results-row', theme);
    },
  },
  {
    name: 'search result row source badge',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          search_threads: playwrightSearchThreadPage,
          search_total: playwrightSearchTotal,
        },
      });
      await page.goto('/');
      await page.getByLabel('Search mail').fill('from:anna');
      await page.getByLabel('Search mail').press('Enter');
      await expect(page.getByText('Re: Q3 invoice')).toBeVisible();
      await screenshot(
        page,
        page.getByTestId('list-slot'),
        'search-result-row-source-badge',
        theme,
      );
    },
  },
  {
    name: 'search zero results',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          search_threads: playwrightEmptySearchPage,
          search_total: playwrightZeroSearchTotal,
        },
      });
      await page.goto('/');
      await page.getByLabel('Search mail').fill('from:anna quarterly');
      await page.getByLabel('Search mail').press('Enter');
      await screenshot(page, page.getByTestId('empty-state-search'), 'search-zero-results', theme);
    },
  },
  {
    name: 'search incomplete backfill notice',
    run: async (page, theme) => {
      await installPlaywrightIpc(page, {
        overrides: {
          list_accounts: [playwrightMailAccount],
          search_threads: playwrightSearchThreadPage,
          search_total: playwrightSearchTotal,
          read_traversal_status: playwrightBackfillingTraversalStatus,
        },
      });
      await page.goto('/');
      await page.getByLabel('Search mail').fill('from:anna');
      await page.getByLabel('Search mail').press('Enter');
      await screenshot(
        page,
        page.getByTestId('search-incomplete-notice'),
        'search-incomplete-notice',
        theme,
      );
    },
  },
];
