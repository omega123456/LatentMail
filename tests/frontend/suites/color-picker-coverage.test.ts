import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  triggerSync,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Color picker coverage', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);

    await triggerSync(electronApp, result.accountId!);
    await waitForMailShell(page);
  });

  // ── Open label form for all tests ──────────────────────────────────

  test('open label creation form to access color picker', async ({ page }) => {
    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    // Verify all color picker elements are present
    await expect(addForm.locator('.sb-square')).toBeVisible();
    await expect(addForm.locator('.hue-slider')).toBeVisible();
    await expect(addForm.locator('.hex-input')).toBeVisible();
    await expect(addForm.locator('.no-color-swatch')).toBeVisible();
  });

  // ── Click preset swatch → becomes selected with check mark ─────────

  test('clicking a preset swatch marks it as selected', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const firstSwatch = addForm.locator('.preset-swatch').first();

    await firstSwatch.click();

    // The swatch should now have aria-checked="true"
    await expect(firstSwatch).toHaveAttribute('aria-checked', 'true');
    // A check mark should be visible inside
    await expect(firstSwatch.locator('.swatch-check')).toBeVisible();
  });

  // ── Click a different swatch → first loses selection ───────────────

  test('clicking a different swatch deselects the previous one', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const firstSwatch = addForm.locator('.preset-swatch').nth(0);
    const secondSwatch = addForm.locator('.preset-swatch').nth(1);

    await secondSwatch.click();

    // Second swatch should be selected
    await expect(secondSwatch).toHaveAttribute('aria-checked', 'true');
    // First swatch should no longer be selected
    await expect(firstSwatch).toHaveAttribute('aria-checked', 'false');
  });

  // ── No-color swatch clears the color ───────────────────────────────

  test('clicking no-color swatch clears hex input and marks it selected', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const noColorSwatch = addForm.locator('.no-color-swatch');

    await noColorSwatch.click();

    // No-color swatch should be selected
    await expect(noColorSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(noColorSwatch).toHaveClass(/selected/);

    // Hex input should be empty
    const hexInput = addForm.locator('.hex-input');
    await expect(hexInput).toHaveValue('');
  });

  // ── Type valid hex → blur → color updates and commits ──────────────

  test('typing valid hex and blurring commits the color', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hexInput = addForm.locator('.hex-input');
    const noColorSwatch = addForm.locator('.no-color-swatch');

    // Fill a valid hex value
    await hexInput.fill('3366CC');
    // Click elsewhere to blur (on the label name input)
    await addForm.locator('input').first().click();

    // After blur, the hex value should be normalized and committed
    const hexValue = await hexInput.inputValue();
    expect(hexValue.length).toBe(6);

    // No-color swatch should no longer be selected (we selected a color)
    await expect(noColorSwatch).toHaveAttribute('aria-checked', 'false');
  });

  // ── Type invalid hex → blur → error state shown ────────────────────

  test('typing invalid hex and blurring shows error state', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hexInput = addForm.locator('.hex-input');
    const hexWrapper = addForm.locator('.hex-input-wrapper');

    // Type an invalid hex
    await hexInput.fill('ZZZZZZ');
    // Blur by clicking elsewhere
    await addForm.locator('input').first().click();

    // The hex wrapper should have the error class
    await expect(hexWrapper).toHaveClass(/error/);
  });

  // ── Type valid hex → Enter → commits without error ─────────────────

  test('typing valid hex and pressing Enter commits the color', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hexInput = addForm.locator('.hex-input');
    const hexWrapper = addForm.locator('.hex-input-wrapper');

    await hexInput.fill('FF6600');
    await hexInput.press('Enter');

    // Error should be cleared
    await expect(hexWrapper).not.toHaveClass(/error/);

    // Value should be committed (normalized)
    const hexValue = await hexInput.inputValue();
    expect(hexValue.toUpperCase()).toBe('FF6600');
  });

  // ── Type something → Escape → reverts to last committed ────────────

  test('typing hex and pressing Escape reverts to last committed value', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hexInput = addForm.locator('.hex-input');

    // Commit a known value first
    await hexInput.fill('00CC88');
    await hexInput.press('Enter');
    const committed = await hexInput.inputValue();

    // Type a different value
    await hexInput.focus();
    await hexInput.selectText();
    await page.keyboard.type('AABB11');

    const midValue = await hexInput.inputValue();
    expect(midValue.toUpperCase()).toBe('AABB11');

    // Press Escape to revert
    await hexInput.press('Escape');

    // Wait for Angular to process
    await page.waitForTimeout(100);

    const revertedValue = await hexInput.inputValue();
    expect(revertedValue.toUpperCase()).toBe(committed.toUpperCase());
  });

  // ── SB square keyboard: ArrowLeft decreases saturation ─────────────

  test('ArrowLeft on SB square decreases saturation', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const sbSquare = addForm.locator('.sb-square');
    const hexInput = addForm.locator('.hex-input');

    // Set a color with moderate saturation
    await hexInput.fill('CC6633');
    await hexInput.press('Enter');
    const hexBefore = await hexInput.inputValue();

    // Focus SB square and press ArrowLeft
    await sbSquare.focus();
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press('ArrowLeft');
    }

    const hexAfter = await hexInput.inputValue();
    expect(hexAfter).not.toBe(hexBefore);
  });

  // ── SB square keyboard: ArrowDown decreases brightness ─────────────

  test('ArrowDown on SB square decreases brightness', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const sbSquare = addForm.locator('.sb-square');
    const hexInput = addForm.locator('.hex-input');

    // Set a color with high brightness
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

  // ── Hue slider keyboard: multiple ArrowUp steps ─────────────────

  test('multiple ArrowUp on hue slider changes hue in reverse', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hueSlider = addForm.locator('.hue-slider');
    const hexInput = addForm.locator('.hex-input');

    // Start with a mid-range hue
    await hexInput.fill('00FF00');
    await hexInput.press('Enter');
    const hexBefore = await hexInput.inputValue();

    await hueSlider.focus();
    // Multiple steps for visible change
    for (let step = 0; step < 10; step++) {
      await page.keyboard.press('ArrowUp');
    }

    const hexAfter = await hexInput.inputValue();
    expect(hexAfter).not.toBe(hexBefore);
  });

  // ── Cancel form to clean up ────────────────────────────────────────

  test('cancel closes the form', async ({ page }) => {
    const addForm = page.locator('.add-form');
    await addForm.getByText('Cancel').click();
    await expect(addForm).not.toBeVisible();
  });
});
