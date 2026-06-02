import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toAtifTrajectory } from '../../src/reporting/atif';
import type { AgentExecutionResult, AgentTrajectoryEvent } from '../../src/shared/types';

function trajectoryEvent(id: string, code: string, blockIds: string[]): AgentTrajectoryEvent {
  return {
    id,
    type: 'playwright',
    description: `Playwright execution ${id}`,
    code,
    blockIds,
    observation: { ok: true },
    startedAt: '2026-06-01T00:00:00.000Z',
    finishedAt: '2026-06-01T00:00:00.010Z',
    durationMs: 10,
  };
}

function result(): AgentExecutionResult {
  return {
    status: 'passed',
    duration: 20,
    errors: [],
    stdout: [],
    stderr: [],
    attachments: [],
    steps: [],
    annotations: [],
    retry: 0,
    startTime: '2026-06-01T00:00:00.000Z',
    workerIndex: 0,
    parallelIndex: 0,
    metrics: {
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_tokens: null,
      total_tokens: 15,
      cost_usd: null,
      extra: { llm_call_count: 2 },
    },
    title: 'multi turn',
    actions: ['go to the page'],
    expectations: ['the title is correct'],
    instructions: [
      { id: 'block-1', steps: 'go to the page' },
      { id: 'block-2', steps: 'verify the title', expect: 'the title is correct' },
    ],
    trajectory: [
      trajectoryEvent('playwright-1', 'await page.goto("https://example.com");', ['block-1']),
      trajectoryEvent('playwright-2', 'await expect(page).toHaveTitle(/Example/);', ['block-2']),
    ],
  };
}

void describe('toAtifTrajectory (multi-turn)', () => {
  void it('emits one user + agent step pair per instruction block in source order', () => {
    const atif = toAtifTrajectory(result(), { sessionId: 'session-1' });

    assert.deepEqual(
      atif.steps.map((step) => step.source),
      ['user', 'agent', 'user', 'agent'],
    );
    assert.equal(atif.final_metrics.total_steps, atif.steps.length);
    assert.equal(atif.final_metrics.total_steps, 4);
  });

  void it('attributes each tool call to the agent step for its block', () => {
    const atif = toAtifTrajectory(result(), { sessionId: 'session-1' });

    const firstAgent = atif.steps[1];
    const secondAgent = atif.steps[3];

    assert.equal(firstAgent.tool_calls?.length, 1);
    assert.match(String(firstAgent.tool_calls?.[0]?.arguments.code), /page\.goto/);
    assert.equal(secondAgent.tool_calls?.length, 1);
    assert.match(String(secondAgent.tool_calls?.[0]?.arguments.code), /toHaveTitle/);
  });

  void it('collects trajectory events with unknown blocks into a trailing agent step', () => {
    const base = result();
    base.trajectory.push(trajectoryEvent('playwright-3', 'await page.waitForTimeout(1);', ['block-unknown']));

    const atif = toAtifTrajectory(base, { sessionId: 'session-1' });

    assert.equal(atif.steps.at(-1)?.source, 'agent');
    assert.equal(atif.steps.at(-1)?.tool_calls?.length, 1);
    assert.match(String(atif.steps.at(-1)?.tool_calls?.[0]?.arguments.code), /waitForTimeout/);
  });
});
