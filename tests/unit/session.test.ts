import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LangChainAgentExecutor } from '../../src/agent/executor.js';
import type {
  AgentDelegate,
  AgentInstructionBlock,
  AgentTestContext,
  AgentTraceEvent,
} from '../../src/shared/types.js';

interface StubInvocation {
  messageCount: number;
}

/**
 * A fake AgentDelegate that decides each turn's per-turn JSON from the last user
 * message, reports a unique usage sample, and returns the full updated message
 * list so the session carries history forward.
 */
function stubAgent(decide: (lastUserContent: string) => string): {
  agent: AgentDelegate;
  invocations: StubInvocation[];
} {
  const invocations: StubInvocation[] = [];
  let turn = 0;

  const agent: AgentDelegate = {
    invoke(input: unknown) {
      const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
      invocations.push({ messageCount: messages.length });
      turn += 1;
      const lastUser = messages[messages.length - 1];
      const content = decide(typeof lastUser?.content === 'string' ? lastUser.content : '');

      return {
        id: `resp-${turn}`,
        usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        messages: [...messages, { role: 'assistant', content, id: `ai-${turn}` }],
      };
    },
  };

  return { agent, invocations };
}

function context(): AgentTestContext {
  return {
    fixtures: {} as AgentTestContext['fixtures'],
    page: {} as AgentTestContext['page'],
    testInfo: {
      title: 'session test',
      annotations: [],
      retry: 0,
      workerIndex: 0,
      parallelIndex: 0,
      testId: 'test-1',
      project: { name: 'unit' },
    } as unknown as AgentTestContext['testInfo'],
    blocks: [],
    nextBlockIndex: 0,
    trace: [],
  };
}

function block(id: string, text: string, kind: AgentInstructionBlock['kind'] = 'steps'): AgentInstructionBlock {
  return { id, kind, text };
}

void describe('LangChainAgentSession', () => {
  void it('accumulates conversation history across turns', async () => {
    const { agent, invocations } = stubAgent(() => '{"status":"ok"}');
    const session = new LangChainAgentExecutor(agent).startSession(context());

    await session.runInstruction(block('block-1', 'go to the page'));
    await session.runInstruction(block('block-2', 'click the button'));

    assert.equal(invocations.length, 2);
    assert.ok(
      invocations[1].messageCount > invocations[0].messageCount,
      'the second turn should see the accumulated history',
    );
  });

  void it('reports a failed turn when the agent does not return ok', async () => {
    const { agent } = stubAgent((content) =>
      content.includes('SHOULD FAIL')
        ? '{"status":"failed","error":{"message":"stub failure"}}'
        : '{"status":"ok"}',
    );
    const session = new LangChainAgentExecutor(agent).startSession(context());

    const ok = await session.runInstruction(block('block-1', 'do a thing'));
    const failed = await session.runInstruction(block('block-2', 'this SHOULD FAIL'));

    assert.equal(ok.status, 'ok');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error?.message ?? '', /stub failure/);
  });

  void it('aggregates metrics across every invocation', async () => {
    const { agent } = stubAgent(() => '{"status":"ok"}');
    const session = new LangChainAgentExecutor(agent).startSession(context());

    await session.runInstruction(block('block-1', 'one'));
    await session.runInstruction(block('block-2', 'two'));
    await session.runInstruction(block('block-3', 'three'));

    const result = session.finalize();

    assert.equal(result.status, 'passed');
    assert.equal(result.metrics.prompt_tokens, 30);
    assert.equal(result.metrics.completion_tokens, 15);
    assert.equal(result.metrics.extra.llm_call_count, 3);
  });

  void it('finalizes a failed run with failure analysis and a non-complete native artifact', async () => {
    const { agent } = stubAgent(() => '{"status":"failed","error":{"message":"boom"}}');
    const ctx = context();
    const session = new LangChainAgentExecutor(agent).startSession(ctx);

    const turn = await session.runInstruction(block('block-1', 'expect something', 'expectation'));
    assert.equal(turn.status, 'failed');

    // Simulate the tool trace the agent would have produced for this turn.
    const trace: AgentTraceEvent = {
      tool: 'playwright_run',
      input: { body: 'await expect(page).toHaveTitle(/x/);', blockIds: ['block-1'] },
      output: { ok: false },
      error: 'title mismatch',
      startedAt: '2026-06-01T00:00:00.000Z',
      finishedAt: '2026-06-01T00:00:00.001Z',
      durationMs: 1,
    };
    ctx.trace.push(trace);
    ctx.blocks.push(block('block-1', 'expect something', 'expectation'));

    const result = session.finalize();

    assert.equal(result.status, 'failed');
    assert.ok(result.failureAnalysis, 'failure analysis should be present for a failed run');
    assert.equal(result.trajectory.length, 1);
    assert.notEqual(result.nativePlaywright?.status, 'complete');
  });

  void it('treats a failed turn as a failed run even when finalize is told passed', async () => {
    const { agent } = stubAgent(() => '{"status":"failed","error":{"message":"turn boom"}}');
    const session = new LangChainAgentExecutor(agent).startSession(context());

    await session.runInstruction(block('block-1', 'do a thing'));
    // A failed turn must win over an optimistic status hint.
    const result = session.finalize({ status: 'passed' });

    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /turn boom/);
  });

  void it('marks the run failed when finalize is given a body error', async () => {
    const { agent } = stubAgent(() => '{"status":"ok"}');
    const session = new LangChainAgentExecutor(agent).startSession(context());

    await session.runInstruction(block('block-1', 'ok step'));
    const result = session.finalize({ status: 'failed', error: { message: 'value-form expect failed' } });

    assert.equal(result.status, 'failed');
    assert.equal(result.error?.message, 'value-form expect failed');
  });
});
