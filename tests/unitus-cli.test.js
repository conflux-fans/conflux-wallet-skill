import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimateTxGas } from '../src/unitus.js';

describe('Unitus CLI gas estimation', () => {
  it('uses each transaction calldata when estimating gas limits', async () => {
    const calls = [];
    const publicClient = {
      async estimateGas(transaction) {
        calls.push(transaction);
        return 100000n;
      },
    };
    const txs = [
      {
        address: '0x00000000000000000000000000000000000000d1',
        value: 0n,
        data: '0x095ea7b30000000000000000000000000000000000000000000000000000000000000001',
      },
      {
        address: '0x00000000000000000000000000000000000000d2',
        value: 5n,
        data: '0x4dd0ef7c',
      },
    ];

    const estimates = await estimateTxGas(
      'conflux',
      publicClient,
      '0x0000000000000000000000000000000000000abc',
      txs,
      { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n },
    );

    assert.equal(estimates.length, 2);
    assert.equal(calls[0].data, txs[0].data);
    assert.equal(calls[1].data, txs[1].data);
  });
});
