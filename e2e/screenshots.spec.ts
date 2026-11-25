import { test } from '@playwright/test';
import { composeScenarios } from './scenarios/compose';
import { readerScenarios } from './scenarios/reader';
import { searchScenarios } from './scenarios/search';
import { settingsScenarios } from './scenarios/settings';
import { themes } from './scenarios/shared';
import { shellScenarios } from './scenarios/shell';

const scenarios = [
  ...shellScenarios,
  ...readerScenarios,
  ...searchScenarios,
  ...composeScenarios,
  ...settingsScenarios,
];

for (const theme of themes) {
  for (const scenario of scenarios) {
    test(`${scenario.name} ${theme}`, async ({ page }) => {
      await scenario.run(page, theme);
    });
  }
}
