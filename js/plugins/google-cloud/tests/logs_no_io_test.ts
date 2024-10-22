/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Genkit, genkit, run, z } from 'genkit';
import { GenerateResponseData } from 'genkit/model';
import assert from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Writable } from 'stream';
import {
  __addTransportStreamForTesting,
  __forceFlushSpansForTesting,
  __getSpanExporterForTesting,
  enableGoogleCloudTelemetry,
} from '../src/index.js';

describe('GoogleCloudLogs no I/O', () => {
  let logLines = '';
  const logStream = new Writable();
  logStream._write = (chunk, encoding, next) => {
    logLines = logLines += chunk.toString();
    next();
  };

  let ai: Genkit;

  before(async () => {
    process.env.GENKIT_ENV = 'dev';
    __addTransportStreamForTesting(logStream);
    await enableGoogleCloudTelemetry({
      projectId: 'test',
      forceDevExport: false,
      metricExportIntervalMillis: 100,
      metricExportTimeoutMillis: 100,
      disableLoggingIO: true,
    });
    ai = genkit({});
    // Wait for the telemetry plugin to be initialized
    await waitForLogsInit(ai, logLines);
  });
  beforeEach(async () => {
    logLines = '';
    __getSpanExporterForTesting().reset();
  });
  after(async () => {
    await ai.stopServers();
  });

  it('writes path logs', async () => {
    const testFlow = createFlow(ai, 'testFlow');

    await testFlow();

    await getExportedSpans();

    const logMessages = await getLogs(1, 100, logLines);
    assert.equal(logMessages.includes('[info] Paths[testFlow]'), true);
  });

  it('writes error logs', async () => {
    const testFlow = createFlow(ai, 'testFlow', async () => {
      const nothing: { missing?: any } = { missing: 1 };
      delete nothing.missing;
      return nothing.missing.explode;
    });

    assert.rejects(async () => {
      await testFlow();
    });

    await getExportedSpans();

    const logMessages = await getLogs(1, 100, logLines);
    assert.equal(
      logMessages.includes(
        "[error] Error[testFlow, TypeError] Cannot read properties of undefined (reading 'explode')"
      ),
      true
    );
  });

  it('writes generate logs', async () => {
    const testModel = createModel(ai, 'testModel', async () => {
      return {
        message: {
          role: 'user',
          content: [
            {
              text: 'response',
            },
          ],
        },
        finishReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 14,
          inputCharacters: 8,
          outputCharacters: 16,
          inputImages: 1,
          outputImages: 3,
        },
      };
    });
    const testFlow = createFlowWithInput(ai, 'testFlow', async (input) => {
      return await run('sub1', async () => {
        return await run('sub2', async () => {
          return await ai.generate({
            model: testModel,
            prompt: `${input} prompt`,
            config: {
              temperature: 1.0,
              topK: 3,
              topP: 5,
              maxOutputTokens: 7,
            },
          });
        });
      });
    });

    await testFlow('test');

    await getExportedSpans();

    const logMessages = await getLogs(1, 100, logLines);
    assert.equal(
      logMessages.includes(
        '[info] Config[testFlow > sub1 > sub2 > generate > testModel, testModel]'
      ),
      true
    );
    assert.equal(
      logMessages.includes(
        '[info] Input[testFlow > sub1 > sub2 > generate > testModel, testModel]'
      ),
      false
    );
    assert.equal(
      logMessages.includes(
        '[info] Output[testFlow > sub1 > sub2 > generate > testModel, testModel]'
      ),
      false
    );
    assert.equal(
      logMessages.includes('[info] Input[testFlow, testModel]'),
      false
    );
    assert.equal(
      logMessages.includes('[info] Output[testFlow, testModel]'),
      false
    );
  });
});

/** Helper to create a flow with no inputs or outputs */
function createFlow(
  ai: Genkit,
  name: string,
  fn: () => Promise<any> = async () => {}
) {
  return ai.defineFlow(
    {
      name,
      inputSchema: z.void(),
      outputSchema: z.void(),
    },
    fn
  );
}

function createFlowWithInput(
  ai: Genkit,
  name: string,
  fn: (input: string) => Promise<any>
) {
  return ai.defineFlow(
    {
      name,
      inputSchema: z.string(),
      outputSchema: z.string(),
    },
    fn
  );
}

/**
 * Helper to create a model that returns the value produced by the given
 * response function.
 */
function createModel(
  genkit: Genkit,
  name: string,
  respFn: () => Promise<GenerateResponseData>
) {
  return genkit.defineModel({ name }, (req) => respFn());
}

async function waitForLogsInit(genkit: Genkit, logLines: any) {
  await import('winston');
  const testFlow = createFlow(genkit, 'testFlow');
  await testFlow();
  await getLogs(1, 100, logLines);
}

async function getLogs(
  logCount: number,
  maxAttempts: number,
  logLines: string
): Promise<String[]> {
  var attempts = 0;
  while (attempts++ < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const found = logLines
      .trim()
      .split('\n')
      .map((l) => l.trim());
    if (found.length >= logCount) {
      return found;
    }
  }
  assert.fail(`Waiting for logs, but none have been written.`);
}

/** Polls the in memory metric exporter until the genkit scope is found. */
async function getExportedSpans(
  maxAttempts: number = 200
): Promise<ReadableSpan[]> {
  __forceFlushSpansForTesting();
  var attempts = 0;
  while (attempts++ < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const found = __getSpanExporterForTesting().getFinishedSpans();
    if (found.length > 0) {
      return found;
    }
  }
  assert.fail(`Timed out while waiting for spans to be exported.`);
}