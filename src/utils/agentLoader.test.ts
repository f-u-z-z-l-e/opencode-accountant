import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgent } from './agentLoader.ts';

describe('loadAgent', () => {
  const TEST_DIR = join(process.cwd(), '.memory', 'test-agents');

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Create a valid agent file
    const validAgent = `---
description: A test agent for accounting tasks
mode: primary
model: claude-sonnet-4
temperature: 0.7
maxSteps: 10
tools:
  bash: true
  read: true
permissions:
  bash:
    allowlist:
      - cat
      - ls
---

You are a helpful accounting assistant.`;

    writeFileSync(join(TEST_DIR, 'test-agent.md'), validAgent);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should load a valid agent file with all fields', () => {
    const agent = loadAgent(join(TEST_DIR, 'test-agent.md'));

    expect(agent).not.toBeNull();
    expect(agent).toEqual({
      description: 'A test agent for accounting tasks',
      mode: 'primary',
      model: 'claude-sonnet-4',
      temperature: 0.7,
      maxSteps: 10,
      tools: {
        bash: true,
        read: true,
      },
      permissions: {
        bash: {
          allowlist: ['cat', 'ls'],
        },
      },
      prompt: 'You are a helpful accounting assistant.',
    });
  });
});
