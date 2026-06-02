import { test, scenario } from '@hakjuoh/langwright/test';

const CLOCK_URL = 'https://demo.playwright.dev/clock';
const TIMER_URL = 'https://demo.playwright.dev/timer';

test.describe('browser clock', () => {
  test.beforeEach(`
    For browser clock instructions, preserve timestamps exactly as written.
    If a timestamp has no timezone suffix, do not add Z or convert it to UTC.
    Use local wall-clock time, for example new Date('2024-02-02T10:00:00').
  `);

  test('set fixed time', async () => {
    await scenario(
      `
        Set the browser clock fixed time to 2024-02-02T10:00:00.
        Go to ${CLOCK_URL}.
      `,
      `The clock should show exactly 10:00:00.`,
    );
  });

  test('manually advance time', async () => {
    await scenario(
      `
        Install the browser clock at 2024-02-02T08:00:00.
        Go to ${CLOCK_URL}.
        Pause the browser clock at 2024-02-02T10:00:00.
      `,
      `The clock should show exactly 10:00:00.`,
    );

    await scenario(
      `Fast-forward the browser clock by 30:00.`,
      `The clock should show exactly 10:30:00.`,
    );
  });

  test('test inactivity monitoring', async () => {
    await scenario(
      `
        Install the browser clock controls with the current time.
        Go to ${TIMER_URL}.
      `,
      `Flash offer should be visible.`,
    );

    await scenario(
      `Fast-forward the browser clock by 05:00.`,
      `Offer Expired should be visible.`,
    );
  });

  test.fail('intentional failure reports clock expectation diagnosis', async () => {
    await scenario(
      `
        Set the browser clock fixed time to 2024-02-02T10:00:00.
        Go to ${CLOCK_URL}.
      `,
      `The clock should show exactly 10:00:01.`,
    );
  });
});
