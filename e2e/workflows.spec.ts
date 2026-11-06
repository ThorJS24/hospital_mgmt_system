import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// the first-run onboarding tour is covered by its own test; everywhere else it would only get in the way
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { try { if (!localStorage.getItem('medicore-tour-v1')) localStorage.setItem('medicore-tour-v1', 'done'); } catch { /* ignore */ } }); });

const ACCOUNTS: Record<string, string> = {
  'receptionist.lindqvist': 'LabFront#2026',
  'doctor.mehta': 'LabDoctor#2026',
  'assessor.vance': 'LabAssess#2026',
  'billing.nakamura': 'LabBill#2026',
  'admin.hartley': 'LabAdmin#2026',
  'patient.portal': 'LabPatient#2026',
};

const go = (page: Page, name: string) => page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name, exact: true }).click();

async function login(page: Page, user: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(ACCOUNTS[user]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('Workflow A: login, role-aware navigation, logout invalidates the session', async ({ page }) => {
  await page.goto('/');
  await login(page, 'receptionist.lindqvist');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Patients' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Billing' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Assessment' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  await expect(page.getByText('Registered patients')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const r = await page.request.get('/api/patients');
  expect(r.status()).toBe(401);
});

test('Workflow B: register a patient, persist, edit', async ({ page }) => {
  await login(page, 'receptionist.lindqvist');
  await go(page, 'Patients');
  await page.getByRole('button', { name: 'Register patient' }).click();
  await page.getByLabel('First name').fill('Playwright');
  await page.getByLabel('Last name').fill('Syntheticson');
  await page.getByLabel('Date of birth').fill('1988-03-14');
  await page.getByRole('dialog').getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Playwright Syntheticson' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Phone').fill('555-0142');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('555-0142')).toBeVisible();
  await go(page, 'Patients');
  await page.getByLabel('Search', { exact: true }).fill('Syntheticson');
  await expect(page.getByRole('cell', { name: 'Syntheticson, Playwright' })).toBeVisible();
});

test('Workflow E: billing invoice, payment and balance', async ({ page }) => {
  await login(page, 'billing.nakamura');
  await go(page, 'Billing');
  await page.getByRole('button', { name: 'New invoice' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Find patient').fill('Ashdown');
  await expect(dlg.getByRole('combobox', { name: /^Patient/ }).locator('option').nth(1)).toBeAttached();
  await dlg.getByRole('combobox', { name: /^Patient/ }).selectOption({ index: 1 });
  await dlg.getByLabel('Description').fill('Consultation');
  await dlg.getByLabel('Unit price').fill('120.50');
  await expect(dlg.getByText('Total: $120.50')).toBeVisible();
  await dlg.getByRole('button', { name: 'Create invoice' }).click();
  // the newest invoice is listed first; open the one just created for this patient
  await page.getByRole('searchbox', { name: 'Search' }).fill('Ashdown');
  await expect(page.getByRole('row').nth(1)).toContainText('$120.50');
  await page.getByRole('row').nth(1).getByRole('button', { name: /^INV-/ }).click();
  await page.getByLabel('Record payment (USD)').fill('20.50');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await expect(page.getByText('$100.00').first()).toBeVisible();
});

test('Workflow F: assessor records a result and generates a report', async ({ page }) => {
  await login(page, 'assessor.vance');
  await expect(page).toHaveURL(/assessment/);
  await expect(page.getByText('Intended vulnerability coverage')).toBeVisible();
  await expect(page.getByText('Assessment verification coverage')).toBeVisible();
  await page.getByRole('tab', { name: 'Test cases' }).click();
  await page.getByRole('row', { name: /HMS-INJ-002/ }).getByRole('button', { name: 'Record result' }).click();
  await page.getByLabel('Outcome').selectOption('pass');
  await page.getByLabel('Actual result').fill('Tautology payload returned zero rows on the secure search');
  await page.getByRole('button', { name: 'Save result' }).click();
  await expect(page.getByRole('row', { name: /HMS-INJ-002/ }).getByText('pass')).toBeVisible();
  await page.getByRole('tab', { name: 'Reports & export' }).click();
  await page.getByRole('button', { name: 'HTML report' }).click();
  await expect(page.getByRole('link', { name: /^R-\d{12}\.html$/ }).first()).toBeVisible();
  const html = await page.request.get((await page.getByRole('link', { name: /^R-\d{12}\.html$/ }).first().getAttribute('href'))!);
  expect(await html.text()).toContain('Not Tested (UNVERIFIED)');
});

test('administrators cannot open assessment data', async ({ page }) => {
  await login(page, 'admin.hartley');
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Assessment' })).toHaveCount(0);
  const r = await page.request.get('/api/assessment/manifest');
  expect(r.status()).toBe(403);
});

test('HMS-V02 is fixed: stored markup in clinical notes is shown as text, not interpreted', async ({ page }) => {
  await login(page, 'doctor.mehta');
  await go(page, 'Patients');
  await page.getByRole('button', { name: /SYN-/ }).first().click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Clinical notes').fill('<b id="lab-marker">benign-marker</b>');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('<b id="lab-marker">benign-marker</b>')).toBeVisible();
  await expect(page.locator('#lab-marker')).toHaveCount(0);
});

test('command palette: Ctrl+K finds a patient and opens the record; "g then p" and "?" shortcuts work', async ({ page }) => {
  await login(page, 'receptionist.lindqvist');
  await page.keyboard.press('Control+k');
  const box = page.getByRole('combobox', { name: /Search or jump to/ });
  await expect(box).toBeFocused();
  await box.fill('Ashdown');
  const option = page.getByRole('option').filter({ hasText: /SYN-/ }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page).toHaveURL(/\/patients\/\d+/);
  await expect(box).toBeHidden(); // shortcuts are ignored while a dialog is still open
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await expect(page).toHaveURL(/\/billing/);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  // typing in a field never triggers shortcuts
  await go(page, 'Patients');
  await page.getByRole('searchbox', { name: 'Search' }).fill('gb?');
  await expect(page).toHaveURL(/\/patients/);
});

test('onboarding tour appears on first visit, can be skipped and does not return', async ({ page }) => {
  // runs once per browser session so that a reload does not reset it again
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('e2e-tour-reset')) { localStorage.removeItem('medicore-tour-v1'); sessionStorage.setItem('e2e-tour-reset', '1'); } } catch { /* ignore */ } });
  await page.goto('/');
  await page.getByLabel('Username').fill('receptionist.lindqvist');
  await page.getByLabel('Password').fill('LabFront#2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#tour-title')).toHaveText('Navigation');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#tour-title')).toHaveText('Search anywhere');
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('#tour-title')).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('#tour-title')).toHaveCount(0);
  // it can be replayed from the help menu
  await page.getByRole('button', { name: 'Help and shortcuts' }).click();
  await page.getByRole('menuitem', { name: 'Replay the quick tour' }).click();
  await expect(page.locator('#tour-title')).toHaveText('Navigation');
});

test('language switch translates the navigation and is remembered', async ({ page }) => {
  await login(page, 'receptionist.lindqvist');
  await page.getByLabel('Language').selectOption('es');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Pacientes' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await page.reload();
  await expect(nav.getByRole('link', { name: 'Pacientes' })).toBeVisible();
  await page.getByLabel('Idioma').selectOption('hi');
  await expect(nav.getByRole('link', { name: 'मरीज़' })).toBeVisible();
  await page.getByLabel('भाषा').selectOption('en');
  await expect(nav.getByRole('link', { name: 'Patients' })).toBeVisible();
});

test('doctor writes, codes and signs a consultation; the record is then locked', async ({ page }) => {
  await login(page, 'doctor.mehta');
  await go(page, 'Consultations');
  await page.getByRole('button', { name: 'New consultation' }).click();
  await page.getByLabel('Find patient').fill('SYN-');
  await page.getByLabel(/^Patient/).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Consultation', exact: true })).toBeVisible();
  await page.getByLabel('Subjective').fill('Headache for three days.');
  await page.getByLabel('Assessment').fill('Tension-type headache, no red flags.');
  await page.getByLabel('Add diagnosis').fill('headache');
  await page.getByRole('button', { name: /R51\.9/ }).click();
  await page.getByRole('button', { name: 'Save diagnoses' }).click();
  await page.getByRole('button', { name: 'Sign and lock' }).click();
  await page.getByRole('button', { name: 'Sign consultation' }).click();
  await expect(page.getByText(/Signed .* Further changes are not possible/)).toBeVisible();
  await expect(page.getByLabel('Subjective')).toHaveCount(0); // read-only now
});

test('prescribing safety: a severe allergy blocks the prescription until an override reason is documented', async ({ page }) => {
  await login(page, 'doctor.mehta');
  await go(page, 'Pharmacy');
  await page.getByRole('button', { name: 'New prescription' }).click();
  await page.getByLabel('Find patient').fill('SYN-');
  const patient = page.getByLabel(/^Patient/);
  await expect(patient.locator('option')).not.toHaveCount(1);
  await patient.selectOption({ index: 1 });
  // give that patient a severe penicillin allergy through the API (same browser session)
  const pid = await patient.inputValue();
  const csrf = (await (await page.request.get('/api/auth/session')).json()).csrfToken;
  await page.request.post(`/api/patients/${pid}/allergies`, { headers: { 'x-csrf-token': csrf }, data: { allergen: 'Penicillin', reaction: 'Anaphylaxis', severity: 'Severe' } });
  await page.getByRole('combobox', { name: /^Medication/ }).selectOption({ label: 'Amoxicillin 500 mg' });
  await page.getByLabel('Dosage instructions').fill('1 capsule three times daily');
  await page.getByRole('button', { name: 'Check safety' }).click();
  await expect(page.getByText(/severe allergy to Penicillin/)).toBeVisible();
  await expect(page.getByText('Blocks prescribing')).toBeVisible();
  const submit = page.getByRole('button', { name: 'Prescribe with override' });
  await expect(submit).toBeDisabled();
  await page.getByLabel(/Override reason/).fill('Allergy history unreliable; supervised test dose planned.');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText('Prescription created')).toBeVisible();
});

test('emergency triage: register an arrival, it is ordered by acuity, and treatment can be started', async ({ page }) => {
  await login(page, 'receptionist.lindqvist');
  await go(page, 'Emergency triage');
  await page.getByRole('button', { name: 'Register arrival' }).click();
  await page.getByLabel('Find patient').fill('SYN-0000');
  const patient = page.getByLabel(/^Patient/);
  await expect(patient.locator('option')).not.toHaveCount(1);
  await patient.selectOption({ index: 1 });
  await page.getByLabel('Presenting complaint').fill('Severe allergic reaction');
  await page.getByLabel('Emergency Severity Index').selectOption('1');
  await page.getByRole('button', { name: 'Add to queue' }).click();
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toContainText('Severe allergic reaction');
  await expect(firstRow).toContainText('ESI 1');
  await expect(page.getByRole('button', { name: 'Start treatment' })).toHaveCount(0); // receptionists cannot treat
});

test('patient portal: a patient books and cancels an appointment and sees their results and bills', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('patient.portal');
  await page.getByLabel('Password').fill('LabPatient#2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /My health/ })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link')).toHaveCount(1); // patients only see their own area
  await page.getByRole('tab', { name: 'Test results' }).click();
  await expect(page.getByRole('cell', { name: 'Complete blood count' })).toBeVisible();
  await page.getByRole('tab', { name: 'Bills' }).click();
  await expect(page.getByRole('cell', { name: 'INV-1111', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Book an appointment' }).first().click();
  await page.getByLabel('Doctor').selectOption({ label: 'Dr. Ingrid Svensson - General Practitioner' });
  const d = new Date(Date.now() + 40 * 86400000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  await page.getByLabel('Date').fill(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  await page.getByRole('radio').first().click();
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('tab', { name: 'Appointments', selected: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Scheduled' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByText('Appointment cancelled')).toBeVisible();
  // staff pages are not reachable
  const r = await page.request.get('/api/patients');
  expect(r.status()).toBe(403);
});

test('notifications bell lists alerts and marks them read', async ({ page }) => {
  await login(page, 'billing.nakamura');
  const bell = page.getByRole('button', { name: /^Notifications \(\d+ unread/ });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/overdue invoice/)).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});

test('new pages render without horizontal overflow on a phone', async ({ page }) => {
  await login(page, 'admin.hartley');
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/consultations', '/triage', '/mar', '/inventory', '/roster', '/reports', '/profile', '/admin']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} horizontal overflow`).toBeLessThanOrEqual(0);
  }
});

test('theme switch applies everywhere and persists; layout does not overflow on a phone', async ({ page }) => {
  await login(page, 'receptionist.lindqvist');
  await page.getByRole('button', { name: /Switch to dark theme/ }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe('rgb(243, 246, 250)');
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/dashboard', '/patients', '/appointments', '/billing']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} horizontal overflow`).toBeLessThanOrEqual(0);
  }
});

// last on purpose: it leaves two-step verification enabled for this account
test('two-step verification: enrol with an authenticator code, then sign in with it', async ({ page }) => {
  const totp = (secret: string, offset = 0) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
    const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
    const h = createHmac('sha1', key).update(counter).digest();
    const o = h[h.length - 1] & 15;
    return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0');
  };
  await login(page, 'billing.nakamura');
  await page.getByRole('link', { name: /Kenji Nakamura/ }).click();
  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  await expect(page.getByAltText('QR code for the authenticator app')).toBeVisible();
  const key = (await page.locator('code[aria-label^="Setup key"]').innerText()).replace(/\s/g, '');
  await page.getByLabel('6-digit code').fill(totp(key));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Save your recovery codes now')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Username').fill('billing.nakamura');
  await page.getByLabel('Password').fill('LabBill#2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await page.getByLabel('Verification code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid verification code');
  await page.getByLabel('Verification code').fill(totp(key, 1)); // next time step: the enrolment code cannot be replayed
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});
