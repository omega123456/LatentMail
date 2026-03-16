import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  triggerSync,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Color picker', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);

    await triggerSync(electronApp, result.accountId!);
    await waitForMailShell(page);
  });

  test.describe('Interactions', () => {
    test('opening label form shows color picker with SB square and hue slider', async ({ page }) => {
      await page.getByTestId('create-label-button').click();

      const addForm = page.locator('.add-form');
      await expect(addForm).toBeVisible();

      await expect(addForm.locator('.sb-square')).toBeVisible();
      await expect(addForm.locator('.hue-slider')).toBeVisible();
      await expect(addForm.locator('.hex-input')).toBeVisible();
      await expect(addForm.locator('.preset-swatch').first()).toBeVisible();
    });

    test('ArrowRight on SB square changes saturation', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const sbSquare = addForm.locator('.sb-square');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('CC6633');
      await hexInput.press('Enter');

      const hexBefore = await hexInput.inputValue();

      await sbSquare.focus();
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('ArrowRight');
      }

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('ArrowUp on SB square changes brightness', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const sbSquare = addForm.locator('.sb-square');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('804020');
      await hexInput.press('Enter');

      const hexBefore = await hexInput.inputValue();

      await sbSquare.focus();
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('ArrowUp');
      }

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('ArrowDown on hue slider changes hue', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hueSlider = addForm.locator('.hue-slider');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('FF0000');
      await hexInput.press('Enter');

      const hexBefore = await hexInput.inputValue();

      await hueSlider.focus();
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('ArrowDown');
      }

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('ArrowUp on hue slider changes hue in opposite direction', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hueSlider = addForm.locator('.hue-slider');
      const hexInput = addForm.locator('.hex-input');

      const hexBefore = await hexInput.inputValue();

      await hueSlider.focus();
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('ArrowUp');
      }

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('typing hex value and pressing Enter commits the color', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('FF0000');
      await hexInput.press('Enter');

      const hexValue = await hexInput.inputValue();
      expect(hexValue.toUpperCase()).toBe('FF0000');

      const sbSquare = addForm.locator('.sb-square');
      const bgColor = await sbSquare.evaluate((element) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gAny = globalThis as any;
        return gAny.getComputedStyle?.(element)?.backgroundColor ?? '';
      });
      expect(bgColor).toBeTruthy();
    });

    test('typing hex value and pressing Escape reverts to committed value', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('00FF00');
      await hexInput.press('Enter');
      const committedValue = await hexInput.inputValue();

      await hexInput.focus();
      await hexInput.selectText();
      await page.keyboard.type('AABB00');

      const midValue = await hexInput.inputValue();
      expect(midValue.toUpperCase()).toBe('AABB00');

      await hexInput.press('Escape');

      await page.waitForTimeout(100);

      const revertedValue = await hexInput.inputValue();
      expect(revertedValue.toUpperCase()).toBe(committedValue.toUpperCase());
    });

    test('pointer drag on SB square changes color', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const sbSquare = addForm.locator('.sb-square');
      const hexInput = addForm.locator('.hex-input');

      const hexBefore = await hexInput.inputValue();

      const box = await sbSquare.boundingBox();
      if (!box) {
        test.skip(true, 'Could not get SB square bounding box');
        return;
      }

      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      const endX = box.x + box.width * 0.8;
      const endY = box.y + box.height * 0.3;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 5 });
      await page.mouse.up();

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('pointer drag on hue slider changes hue', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hueSlider = addForm.locator('.hue-slider');
      const hexInput = addForm.locator('.hex-input');

      const hexBefore = await hexInput.inputValue();

      const box = await hueSlider.boundingBox();
      if (!box) {
        test.skip(true, 'Could not get hue slider bounding box');
        return;
      }

      const startX = box.x + box.width / 2;
      const startY = box.y + box.height * 0.2;
      const endY = box.y + box.height * 0.8;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, endY, { steps: 5 });
      await page.mouse.up();

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('cancel closes the form', async ({ page }) => {
      const addForm = page.locator('.add-form');
      await addForm.getByText('Cancel').click();
      await expect(addForm).not.toBeVisible();
    });
  });

  test.describe('Coverage', () => {
    test('open label creation form to access color picker', async ({ page }) => {
      await page.getByTestId('create-label-button').click();

      const addForm = page.locator('.add-form');
      await expect(addForm).toBeVisible();

      await expect(addForm.locator('.sb-square')).toBeVisible();
      await expect(addForm.locator('.hue-slider')).toBeVisible();
      await expect(addForm.locator('.hex-input')).toBeVisible();
      await expect(addForm.locator('.no-color-swatch')).toBeVisible();
    });

    test('clicking a preset swatch marks it as selected', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const firstSwatch = addForm.locator('.preset-swatch').first();

      await firstSwatch.click();

      await expect(firstSwatch).toHaveAttribute('aria-checked', 'true');
      await expect(firstSwatch.locator('.swatch-check')).toBeVisible();
    });

    test('clicking a different swatch deselects the previous one', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const firstSwatch = addForm.locator('.preset-swatch').nth(0);
      const secondSwatch = addForm.locator('.preset-swatch').nth(1);

      await secondSwatch.click();

      await expect(secondSwatch).toHaveAttribute('aria-checked', 'true');
      await expect(firstSwatch).toHaveAttribute('aria-checked', 'false');
    });

    test('clicking no-color swatch clears hex input and marks it selected', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const noColorSwatch = addForm.locator('.no-color-swatch');

      await noColorSwatch.click();

      await expect(noColorSwatch).toHaveAttribute('aria-checked', 'true');
      await expect(noColorSwatch).toHaveClass(/selected/);

      const hexInput = addForm.locator('.hex-input');
      await expect(hexInput).toHaveValue('');
    });

    test('typing valid hex and blurring commits the color', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hexInput = addForm.locator('.hex-input');
      const noColorSwatch = addForm.locator('.no-color-swatch');

      await hexInput.fill('3366CC');
      await addForm.locator('input').first().click();

      const hexValue = await hexInput.inputValue();
      expect(hexValue.length).toBe(6);

      await expect(noColorSwatch).toHaveAttribute('aria-checked', 'false');
    });

    test('typing invalid hex and blurring shows error state', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hexInput = addForm.locator('.hex-input');
      const hexWrapper = addForm.locator('.hex-input-wrapper');

      await hexInput.fill('ZZZZZZ');
      await addForm.locator('input').first().click();

      await expect(hexWrapper).toHaveClass(/error/);
    });

    test('typing valid hex and pressing Enter commits the color', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hexInput = addForm.locator('.hex-input');
      const hexWrapper = addForm.locator('.hex-input-wrapper');

      await hexInput.fill('FF6600');
      await hexInput.press('Enter');

      await expect(hexWrapper).not.toHaveClass(/error/);

      const hexValue = await hexInput.inputValue();
      expect(hexValue.toUpperCase()).toBe('FF6600');
    });

    test('typing hex and pressing Escape reverts to last committed value', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('00CC88');
      await hexInput.press('Enter');
      const committed = await hexInput.inputValue();

      await hexInput.focus();
      await hexInput.selectText();
      await page.keyboard.type('AABB11');

      const midValue = await hexInput.inputValue();
      expect(midValue.toUpperCase()).toBe('AABB11');

      await hexInput.press('Escape');

      await page.waitForTimeout(100);

      const revertedValue = await hexInput.inputValue();
      expect(revertedValue.toUpperCase()).toBe(committed.toUpperCase());
    });

    test('ArrowLeft on SB square decreases saturation', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const sbSquare = addForm.locator('.sb-square');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('CC6633');
      await hexInput.press('Enter');
      const hexBefore = await hexInput.inputValue();

      await sbSquare.focus();
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('ArrowLeft');
      }

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('ArrowDown on SB square decreases brightness', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const sbSquare = addForm.locator('.sb-square');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('FF8844');
      await hexInput.press('Enter');
      const hexBefore = await hexInput.inputValue();

      await sbSquare.focus();
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('ArrowDown');
      }

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('multiple ArrowUp on hue slider changes hue in reverse', async ({ page }) => {
      const addForm = page.locator('.add-form');
      const hueSlider = addForm.locator('.hue-slider');
      const hexInput = addForm.locator('.hex-input');

      await hexInput.fill('00FF00');
      await hexInput.press('Enter');
      const hexBefore = await hexInput.inputValue();

      await hueSlider.focus();
      for (let step = 0; step < 10; step++) {
        await page.keyboard.press('ArrowUp');
      }

      const hexAfter = await hexInput.inputValue();
      expect(hexAfter).not.toBe(hexBefore);
    });

    test('cancel closes the form', async ({ page }) => {
      const addForm = page.locator('.add-form');
      await addForm.getByText('Cancel').click();
      await expect(addForm).not.toBeVisible();
    });
  });
});
