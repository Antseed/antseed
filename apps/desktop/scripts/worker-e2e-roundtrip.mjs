// Run by worker-e2e-electron.test.mjs under the desktop's own runtime: a buyer seals a request
// for a worker and opens its sealed answer, with the code the packaged buyer runs.
import assert from 'node:assert/strict';
import { generateWorkerEncryptionKey, openRequest, sealRequest } from '@antseed/node/worker-e2e';

const worker = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const key = generateWorkerEncryptionKey();
const body = new TextEncoder().encode(JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] }));

const sealed = await sealRequest({ body, worker, workerKey: key.publicKey });
const opened = openRequest(sealed.body, worker, key);
assert.deepEqual(Buffer.from(opened.body), Buffer.from(body));

const answer = new TextEncoder().encode(JSON.stringify({ answer: 1 }));
assert.deepEqual(Buffer.from(sealed.opener.openBody(opened.sealer.sealBody(answer))), Buffer.from(answer));
assert.equal(sealed.opener.verified, true);
console.log(`ok electron=${process.versions.electron}`);
