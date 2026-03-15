import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  triggerSync,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Color picker interactions', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);

    await triggerSync(electronApp, result.accountId!);
    await waitForMailShell(page);
  });

  // ── Open label creation form ─────────────────────────────────────────

  test('opening label form shows color picker with SB square and hue slider', async ({ page }) => {
    await page.getByTestId('create-label-button').click();

    const addForm = page.locator('.add-form');
    await expect(addForm).toBeVisible();

    // Verify color picker components are present
    await expect(addForm.locator('.sb-square')).toBeVisible();
    await expect(addForm.locator('.hue-slider')).toBeVisible();
    await expect(addForm.locator('.hex-input')).toBeVisible();
    await expect(addForm.locator('.preset-swatch').first()).toBeVisible();
  });

  // ── Keyboard navigation on SB square (ArrowRight) ────────────────────

  test('ArrowRight on SB square changes saturation', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const sbSquare = addForm.locator('.sb-square');
    const hexInput = addForm.locator('.hex-input');

    // Set a color with moderate saturation (NOT zero and NOT max) so ArrowRight makes a visible difference
    // CC6633 ≈ HSB(20, 75%, 80%) — has room to increase saturation
    await hexInput.fill('CC6633');
    await hexInput.press('Enter');

    // Record hex value after setting the color
    const hexBefore = await hexInput.inputValue();

    // Focus the SB square and press ArrowRight multiple times to increase saturation visibly
    await sbSquare.focus();
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press('ArrowRight');
    }

    // Hex value should change (saturation increased)
    const hexAfter = await hexInput.inputValue();
    expect(hexAfter).not.toBe(hexBefore);
  });

  // ── Keyboard navigation on SB square (ArrowUp) ──────────────────────

  test('ArrowUp on SB square changes brightness', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const sbSquare = addForm.locator('.sb-square');
    const hexInput = addForm.locator('.hex-input');

    // Set a color with medium brightness and some saturation so ArrowUp makes a visible difference
    await hexInput.fill('804020');
    await hexInput.press('Enter');

    const hexBefore = await hexInput.inputValue();

    await sbSquare.focus();
    // Press ArrowUp multiple times for visible change
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press('ArrowUp');
    }

    const hexAfter = await hexInput.inputValue();
    expect(hexAfter).not.toBe(hexBefore);
  });

  // ── Keyboard navigation on hue slider (ArrowDown) ────────────────────

  test('ArrowDown on hue slider changes hue', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hueSlider = addForm.locator('.hue-slider');
    const hexInput = addForm.locator('.hex-input');

    // Set a saturated color first so hue changes are visible in the hex value
    await hexInput.fill('FF0000');
    await hexInput.press('Enter');

    const hexBefore = await hexInput.inputValue();

    await hueSlider.focus();
    // Press ArrowDown multiple times to ensure a visible change (each step = 1 degree)
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press('ArrowDown');
    }

    const hexAfter = await hexInput.inputValue();
    expect(hexAfter).not.toBe(hexBefore);
  });

  // ── Keyboard navigation on hue slider (ArrowUp) ──────────────────────

  test('ArrowUp on hue slider changes hue in opposite direction', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hueSlider = addForm.locator('.hue-slider');
    const hexInput = addForm.locator('.hex-input');

    const hexBefore = await hexInput.inputValue();

    await hueSlider.focus();
    // Press ArrowUp multiple times to ensure a visible change
    for (let step = 0; step < 5; step++) {
      await page.keyboard.press('ArrowUp');
    }

    const hexAfter = await hexInput.inputValue();
    expect(hexAfter).not.toBe(hexBefore);
  });

  // ── Hex input Enter key commits color ────────────────────────────────

  test('typing hex value and pressing Enter commits the color', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hexInput = addForm.locator('.hex-input');

    await hexInput.fill('FF0000');
    await hexInput.press('Enter');

    // After commit, the input should still have the value (normalized)
    const hexValue = await hexInput.inputValue();
    expect(hexValue.toUpperCase()).toBe('FF0000');

    // The SB square background should have changed (it reflects the hue)
    const sbSquare = addForm.locator('.sb-square');
    const bgColor = await sbSquare.evaluate((element) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gAny = globalThis as any;
      return gAny.getComputedStyle?.(element)?.backgroundColor ?? '';
    });
    expect(bgColor).toBeTruthy();
  });

  // ── Hex input Escape key reverts to committed value ──────────────────

  test('typing hex value and pressing Escape reverts to committed value', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const hexInput = addForm.locator('.hex-input');

    // Commit a known color first
    await hexInput.fill('00FF00');
    await hexInput.press('Enter');
    const committedValue = await hexInput.inputValue();

    // Type something else using keyboard (focus is already on the input after Enter)
    await hexInput.focus();
    await hexInput.selectText();
    await page.keyboard.type('AABB00');

    // Verify the input changed
    const midValue = await hexInput.inputValue();
    expect(midValue.toUpperCase()).toBe('AABB00');

    // Press Escape to revert
    await hexInput.press('Escape');

    // Wait for Angular to update the DOM
    await page.waitForTimeout(100);

    const revertedValue = await hexInput.inputValue();
    expect(revertedValue.toUpperCase()).toBe(committedValue.toUpperCase());
  });

  // ── Pointer drag on SB square ────────────────────────────────────────

  test('pointer drag on SB square changes color', async ({ page }) => {
    const addForm = page.locator('.add-form');
    const sbSquare = addForm.locator('.sb-square');
    const hexInput = addForm.locator('.hex-input');

    const hexBefore = await hexInput.inputValue();

    // Get bounding box for the SB square
    const box = await sbSquare.boundingBox();
    if (!box) {
      test.skip(true, 'Could not get SB square bounding box');
      return;
    }

    // Simulate a pointer drag from center to a different position
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

  // ── Pointer drag on hue slider ───────────────────────────────────────

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

  // ── Cancel form ──────────────────────────────────────────────────────

  test('cancel closes the form', async ({ page }) => {
    const addForm = page.locator('.add-form');
    await addForm.getByText('Cancel').click();
    await expect(addForm).not.toBeVisible();
  });
});
