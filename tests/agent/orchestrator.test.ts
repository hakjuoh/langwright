import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LangwrightExecutor } from '../../src/agent/orchestrator';
import type {
  AgentTestContext,
  Generator,
  GeneratorInput,
  Healer,
  HealerDiagnosis,
  MetricSample,
  ScenarioBlock,
} from '../../src/shared/types';

const sample: MetricSample = {
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  metadata: { model_name: 'stub-model' },
};

/**
 * A Generator that turns each scenario into canned code chosen from the steps
 * text, recording how many times it was called.
 */
function stubGenerator(decide: (block: ScenarioBlock) => string): Generator & { calls: number } {
  return {
    calls: 0,
    generate(input: GeneratorInput) {
      this.calls += 1;

      return Promise.resolve({
        generated: { blockId: input.block.id, actionCode: decide(input.block) },
        metrics: [sample],
      });
    },
  };
}

function stubHealer(diagnosis: HealerDiagnosis): Healer & { calls: number } {
  return {
    calls: 0,
    heal() {
      this.calls += 1;

      return Promise.resolve({ diagnosis, metrics: [sample] });
    },
  };
}

const DIAGNOSIS: HealerDiagnosis = {
  summary: 'The scenario failed because the action threw.',
  findings: [
    {
      title: 'Action threw',
      category: 'defect',
      owner: 'app',
      confidence: 0.8,
      explanation: 'The generated action raised an error.',
      suggestedFix: { rationale: 'Fix the underlying behavior.', risk: 'medium' },
    },
  ],
};

/** A fake page sufficient for snapshotting and for running canned code. */
function fakePage() {
  return {
    url: () => 'https://app.example/page',
    title: () => Promise.resolve('Fake Title'),
    locator: () => ({ ariaSnapshot: () => Promise.resolve('- body') }),
    ping: () => Promise.resolve('pong'),
  };
}

function fakeContext(): AgentTestContext {
  const page = fakePage();

  return {
    fixtures: {
      page,
      playwright: { devices: {}, chromium: {}, firefox: {}, webkit: {}, selectors: {}, errors: {}, request: undefined },
    } as unknown as AgentTestContext['fixtures'],
    page: page as unknown as AgentTestContext['page'],
    testInfo: {
      title: 'orchestrator test',
      annotations: [],
      retry: 0,
      workerIndex: 0,
      parallelIndex: 0,
      testId: 'test-1',
      project: { name: 'unit' },
    } as unknown as AgentTestContext['testInfo'],
    blocks: [],
    nextBlockIndex: 0,
  };
}

function block(id: string, steps: string, expect?: string): ScenarioBlock {
  return { id, steps, expect };
}

async function passesScenarioWithoutHealer(): Promise<void> {
  const generator = stubGenerator(() => 'await page.ping();');
  const healer = stubHealer(DIAGNOSIS);
  const session = new LangwrightExecutor(generator, healer).startSession(fakeContext());

  const outcome = await session.runScenario(block('block-1', 'ping the page'));
  const result = session.finalize();

  assert.equal(outcome.status, 'ok');
  assert.equal(healer.calls, 0, 'a passing scenario must not invoke the Healer');
  assert.equal(result.status, 'passed');
  assert.equal(result.nativePlaywright?.status, 'complete');
  assert.equal(result.metrics.extra.llm_call_count, 1, 'only the Generator ran');
}

async function healsFailedScenario(): Promise<void> {
  const generator = stubGenerator(() => 'throw new Error("scenario boom");');
  const healer = stubHealer(DIAGNOSIS);
  const session = new LangwrightExecutor(generator, healer).startSession(fakeContext());

  const outcome = await session.runScenario(block('block-1', 'do a thing', 'something is true'));
  const result = session.finalize();

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error?.message ?? '', /scenario boom/);
  assert.equal(healer.calls, 1, 'a failed scenario invokes the Healer once');
  assert.equal(result.status, 'failed');
  assert.ok(result.failureAnalysis, 'failed run carries failure analysis');
  assert.equal(result.failureAnalysis?.findings[0]?.provenance, 'agent');
  assert.match(result.failureAnalysis?.findings[0]?.title ?? '', /Action threw/);
  assert.notEqual(result.nativePlaywright?.status, 'complete');
  assert.equal(result.metrics.extra.llm_call_count, 2, 'Generator + Healer');
  assert.equal(result.trajectory.length, 1);
}

async function reportsDeterministicDiagnosisWithoutHealer(): Promise<void> {
  const generator = stubGenerator(() => 'throw new Error("scenario boom");');
  const session = new LangwrightExecutor(generator).startSession(fakeContext());

  const outcome = await session.runScenario(block('block-1', 'do a thing'));
  const result = session.finalize();

  assert.equal(outcome.status, 'failed');
  assert.ok(result.failureAnalysis, 'failure analysis is still produced without a Healer');
  assert.equal(result.failureAnalysis?.findings[0]?.provenance, 'fallback');
  assert.equal(result.metrics.extra.llm_call_count, 1, 'only the Generator ran; no heal step');
  assert.equal(result.metrics.extra.healer_call_count, 0);
}

async function runsScenariosFailFast(): Promise<void> {
  const generator = stubGenerator((scenarioBlock) =>
    scenarioBlock.id === 'block-1' ? 'throw new Error("first fails");' : 'await page.ping();',
  );
  const healer = stubHealer(DIAGNOSIS);
  const context = fakeContext();
  context.blocks = [block('block-1', 'first'), block('block-2', 'second')];

  const result = await new LangwrightExecutor(generator, healer).run(context);

  assert.equal(result.status, 'failed');
  assert.equal(generator.calls, 1, 'the second scenario must not run after the first fails');
  assert.equal(result.trajectory.length, 1);
}

async function treatsBodyErrorAsFailedRun(): Promise<void> {
  const generator = stubGenerator(() => 'await page.ping();');
  const session = new LangwrightExecutor(generator, stubHealer(DIAGNOSIS)).startSession(fakeContext());

  await session.runScenario(block('block-1', 'ok step'));
  const result = session.finalize({ status: 'failed', error: { message: 'body-level failure' } });

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.message, 'body-level failure');
}

void describe('LangwrightExecutor session', () => {
  void it('passes a scenario without invoking the Healer and emits complete native code', passesScenarioWithoutHealer);
  void it('heals a failed scenario, marks the run failed, and attaches failure analysis', healsFailedScenario);
  void it('reports a deterministic diagnosis when no Healer is configured (heal is optional)', reportsDeterministicDiagnosisWithoutHealer);
  void it('runs scenarios fail-fast in the one-shot path', runsScenariosFailFast);
  void it('treats a body error passed to finalize as a failed run even after a passing scenario', treatsBodyErrorAsFailedRun);
});
