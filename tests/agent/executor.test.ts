import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentExecutor } from '../../src/agent/executor';
import type {
  AgentExecutor,
  AgentTestContext,
  Generator,
  GeneratorInput,
  Healer,
  HealerDiagnosis,
} from '../../src/shared/types';

const DIAGNOSIS: HealerDiagnosis = {
  summary: 'Healer ran.',
  findings: [
    {
      title: 'Diagnosed cause',
      category: 'defect',
      owner: 'app',
      confidence: 0.8,
      explanation: 'why',
      suggestedFix: { rationale: 'fix it', risk: 'low' },
    },
  ],
};

function stubGenerator(actionCode: string): Generator & { calls: number } {
  return {
    calls: 0,
    generate(input: GeneratorInput) {
      this.calls += 1;

      return Promise.resolve({ generated: { blockId: input.block.id, actionCode }, metrics: [] });
    },
  };
}

function stubHealer(): Healer & { calls: number } {
  return {
    calls: 0,
    heal() {
      this.calls += 1;

      return Promise.resolve({ diagnosis: DIAGNOSIS, metrics: [] });
    },
  };
}

function fakeContext(steps: string): AgentTestContext {
  const page = {
    url: () => 'https://app.example/page',
    title: () => Promise.resolve('Fake Title'),
    locator: () => ({ ariaSnapshot: () => Promise.resolve('- body') }),
  };

  return {
    fixtures: {
      page,
      playwright: { devices: {}, chromium: {}, firefox: {}, webkit: {}, selectors: {}, errors: {}, request: undefined },
    } as unknown as AgentTestContext['fixtures'],
    page: page as unknown as AgentTestContext['page'],
    testInfo: {
      title: 'executor test',
      annotations: [],
      retry: 0,
      workerIndex: 0,
      parallelIndex: 0,
      testId: 'test-1',
      project: { name: 'unit' },
    } as unknown as AgentTestContext['testInfo'],
    blocks: [{ id: 'block-1', steps }],
    nextBlockIndex: 1,
  };
}

void describe('createAgentExecutor', () => {
  void it('returns the custom executor when one is configured', () => {
    const custom = { startSession() {}, run() {} } as unknown as AgentExecutor;

    assert.equal(createAgentExecutor({ executor: custom }), custom);
  });

  void it('throws when neither a model nor a generator is configured (Generate is mandatory)', () => {
    assert.throws(() => createAgentExecutor({}), /requires a chat model/);
  });

  void it('throws even when only a healer is configured, since the Generator is required', () => {
    assert.throws(() => createAgentExecutor({ healer: stubHealer() }), /requires a chat model/);
  });

  void it('wires pre-built Generator and Healer (no base model) and heals on failure', async () => {
    const generator = stubGenerator('throw new Error("boom");');
    const healer = stubHealer();

    const result = await createAgentExecutor({ generator, healer }).run(fakeContext('do a thing'));

    assert.equal(result.status, 'failed');
    assert.equal(generator.calls, 1);
    assert.equal(healer.calls, 1, 'a configured Healer runs on failure');
    assert.equal(result.failureAnalysis?.findings[0]?.provenance, 'agent');
    assert.equal(result.metrics.extra.healer_call_count, 1);
  });

  void it('disables healing with healer:false and reports a deterministic diagnosis', async () => {
    const generator = stubGenerator('throw new Error("boom");');

    const result = await createAgentExecutor({ generator, healer: false }).run(fakeContext('do a thing'));

    assert.equal(result.status, 'failed');
    assert.equal(result.failureAnalysis?.findings[0]?.provenance, 'fallback');
    assert.equal(result.metrics.extra.healer_call_count, 0);
  });

  void it('treats an absent Healer (generator only, no model) as healing disabled', async () => {
    const generator = stubGenerator('throw new Error("boom");');

    const result = await createAgentExecutor({ generator }).run(fakeContext('do a thing'));

    assert.equal(result.status, 'failed');
    assert.equal(result.failureAnalysis?.findings[0]?.provenance, 'fallback');
    assert.equal(result.metrics.extra.healer_call_count, 0);
  });
});
