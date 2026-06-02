import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineConfig } from '../../src/config.js';

void describe('defineConfig', () => {
  void it('fills default agent metadata', () => {
    const config = defineConfig({});

    assert.equal(config.agentName, 'langwright-agent');
    assert.equal(config.agentVersion, '0.1.0');
  });

  void it('preserves explicit agent metadata overrides', () => {
    const config = defineConfig({
      agentName: 'custom-agent',
      agentVersion: '2026.05',
    });

    assert.equal(config.agentName, 'custom-agent');
    assert.equal(config.agentVersion, '2026.05');
  });
});
