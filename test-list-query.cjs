const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const apiUrl = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
let passed = 0;

// Only GET requests are used. No database connection or credentials are needed.
async function get(path, expectedStatus = 200) {
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw new Error(`GET ${path}: ${error.message}. Check that the server is running.`);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`GET ${path}: HTTP ${response.status} did not return JSON: ${text.slice(0, 200)}`);
  }

  assert.equal(
    response.status, expectedStatus,
    `GET ${path}: expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`
  );
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `GET ${path}: expected a JSON object`);
  assert.equal(typeof body.message, 'string', `GET ${path}: missing message string`);
  assert.ok(body.message.length > 0, `GET ${path}: empty message`);
  assert.ok(Object.hasOwn(body, 'data'), `GET ${path}: missing data field`);
  if (expectedStatus >= 400) assert.equal(body.data, null, `GET ${path}: error data should be null`);
  return body.data;
}

function queryString(parameters) {
  return new URLSearchParams(
    Object.entries(parameters).map(([key, value]) => [key, JSON.stringify(value)])
  ).toString();
}

async function list(collection, parameters = {}, status = 200) {
  const query = queryString(parameters);
  const data = await get(`/api/${collection}${query ? `?${query}` : ''}`, status);
  if (status === 200 && parameters.count !== true) {
    assert.ok(Array.isArray(data), `GET /api/${collection}: expected an array`);
  }
  return data;
}

async function snapshot() {
  const [users, tasks] = await Promise.all([
    list('users', { sort: { _id: 1 }, limit: 0 }),
    list('tasks', { sort: { _id: 1 }, limit: 0 })
  ]);
  return { users, tasks };
}

async function check(label, run) {
  await run();
  passed += 1;
  console.log(`PASS ${passed}/94: ${label}`);
}

function without(document, ...fields) {
  return Object.fromEntries(Object.entries(document).filter(([key]) => !fields.includes(key)));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function checkCollection(collection, documents, baseline) {
  const path = `/api/${collection}`;
  const [first, second] = documents;
  const pair = [first, second];
  const pairWhere = { _id: { $in: pair.map(document => document._id) } };
  const missingWhere = { _id: randomBytes(12).toString('hex') };
  const pairQuery = { where: pairWhere, sort: { _id: 1 }, limit: 0 };
  const run = (parameters = {}, status = 200) => list(collection, parameters, status);
  const namedCheck = (label, test) => check(`${collection}: ${label}`, test);
  const raw = (parameters, status = 400) => get(`${path}?${new URLSearchParams(parameters)}`, status);

  await namedCheck('default list uses the required resource-specific limit', async () => {
    const result = await run();
    assert.equal(result.length, collection === 'tasks' ? Math.min(documents.length, 100) : documents.length);
  });

  await namedCheck('where can match one existing ID', async () => {
    assert.deepEqual(await run({ where: { _id: first._id } }), [first]);
  });

  await namedCheck('where supports an $in query', async () => {
    assert.deepEqual(await run(pairQuery), pair);
  });

  await namedCheck('where supports $eq', async () => {
    assert.deepEqual(await run({ where: { _id: { $eq: first._id } } }), [first]);
  });

  await namedCheck('where supports $ne', async () => {
    assert.deepEqual(
      await run({ where: { _id: { $ne: first._id } }, sort: { _id: 1 }, limit: 0 }),
      documents.slice(1)
    );
  });

  await namedCheck('where supports $or', async () => {
    assert.deepEqual(await run({
      where: { $or: pair.map(document => ({ _id: document._id })) },
      sort: { _id: 1 }, limit: 0
    }), pair);
  });

  await namedCheck('where supports combined $and conditions', async () => {
    assert.deepEqual(await run({
      where: { $and: [{ _id: first._id }, { name: first.name }] }
    }), [first]);
  });

  await namedCheck('a filter with no matches returns 200 and an empty array', async () => {
    assert.deepEqual(await run({ where: missingWhere }), []);
  });

  await namedCheck('sort orders IDs ascending', async () => {
    assert.deepEqual(await run({ sort: { _id: 1 }, limit: 0 }), documents);
  });

  await namedCheck('sort orders IDs descending', async () => {
    assert.deepEqual(await run({ sort: { _id: -1 }, limit: 0 }), [...documents].reverse());
  });

  await namedCheck('compound sort orders names ascending with an ID tie-breaker', async () => {
    const expected = [...documents].sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a._id, b._id));
    assert.deepEqual(await run({ sort: { name: 1, _id: 1 }, limit: 0 }), expected);
  });

  await namedCheck('compound sort orders names descending with an ID tie-breaker', async () => {
    const expected = [...documents].sort((a, b) => compareStrings(b.name, a.name) || compareStrings(a._id, b._id));
    assert.deepEqual(await run({ sort: { name: -1, _id: 1 }, limit: 0 }), expected);
  });

  await namedCheck('an inclusion projection retains the default _id', async () => {
    assert.deepEqual(await run({ ...pairQuery, select: { name: 1 } }),
      pair.map(document => ({ _id: document._id, name: document.name })));
  });

  await namedCheck('an inclusion projection can exclude _id', async () => {
    assert.deepEqual(await run({ ...pairQuery, select: { name: 1, _id: 0 } }),
      pair.map(document => ({ name: document.name })));
  });

  await namedCheck('an exclusion projection retains other fields', async () => {
    assert.deepEqual(await run({ ...pairQuery, select: { name: 0 } }),
      pair.map(document => without(document, 'name')));
  });

  await namedCheck('an _id-only projection returns only IDs', async () => {
    assert.deepEqual(await run({ ...pairQuery, select: { _id: 1 } }),
      pair.map(document => ({ _id: document._id })));
  });

  await namedCheck('excluding _id retains all remaining fields', async () => {
    assert.deepEqual(await run({ ...pairQuery, select: { _id: 0 } }),
      pair.map(document => without(document, '_id')));
  });

  await namedCheck('an empty select object returns complete documents', async () => {
    assert.deepEqual(await run({ ...pairQuery, select: {} }), pair);
  });

  await namedCheck('an unknown selected field can return empty objects', async () => {
    assert.deepEqual(await run({ ...pairQuery, select: { fieldThatDoesNotExistForListTest: 1, _id: 0 } }), [{}, {}]);
  });

  await namedCheck('skip omits the first result', async () => {
    assert.deepEqual(await run({ sort: { _id: 1 }, skip: 1, limit: 0 }), documents.slice(1));
  });

  await namedCheck('limit can return exactly one result', async () => {
    assert.deepEqual(await run({ sort: { _id: 1 }, limit: 1 }), [first]);
  });

  await namedCheck('skip and limit combine into a page', async () => {
    assert.deepEqual(await run({ sort: { _id: 1 }, skip: 1, limit: 1 }), [second]);
  });

  await namedCheck('skipping past the final result returns an empty array', async () => {
    assert.deepEqual(await run({ sort: { _id: 1 }, skip: documents.length + 1, limit: 2 }), []);
  });

  await namedCheck('explicit limit zero means unlimited', async () => {
    assert.deepEqual(await run({ sort: { _id: 1 }, skip: 0, limit: 0 }), documents);
  });

  await namedCheck('count true returns the total as a number', async () => {
    assert.equal(await run({ count: true }), documents.length);
  });

  await namedCheck('count applies the where condition', async () => {
    assert.equal(await run({ where: pairWhere, count: true }), 2);
  });

  await namedCheck('count with no matches returns zero', async () => {
    assert.equal(await run({ where: missingWhere, count: true }), 0);
  });

  await namedCheck('count false still returns records', async () => {
    assert.deepEqual(await run({ ...pairQuery, count: false }), pair);
  });

  await namedCheck('count ignores skip and limit', async () => {
    assert.equal(await run({ where: pairWhere, skip: documents.length + 1, limit: 1, count: true }), 2);
  });

  await namedCheck('all six parameters combine in a record query', async () => {
    assert.deepEqual(await run({
      where: pairWhere, sort: { _id: 1 }, select: { name: 1, _id: 0 },
      skip: 1, limit: 1, count: false
    }), [{ name: second.name }]);
  });

  await namedCheck('all six parameters combine in a total-count query', async () => {
    assert.equal(await run({
      where: pairWhere, sort: { name: -1 }, select: { name: 1, _id: 0 },
      skip: documents.length + 1, limit: 1, count: true
    }), 2);
  });

  await namedCheck('invalid JSON is rejected for each of the six parameters', async () => {
    for (const parameter of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
      await raw({ [parameter]: '{' });
    }
  });

  await namedCheck('where rejects non-object JSON values and invalid filters', async () => {
    for (const where of [
      null, [], 1, 'name', true,
      { _id: 'invalid-id' },
      { name: { $invalidOperator: 1 } },
      { $invalidOperator: 1 },
      { name: { $regex: '[' } }
    ]) await run({ where }, 400);
  });

  await namedCheck('sort rejects non-object JSON values', async () => {
    for (const sort of [null, [], 1, 'name', true]) await run({ sort }, 400);
  });

  await namedCheck('select rejects non-object JSON values', async () => {
    for (const select of [null, [], 1, 'name', true]) await run({ select }, 400);
  });

  await namedCheck('sort rejects invalid directions', async () => {
    for (const direction of [0, 2, -2, 'asc', true, null, { $meta: 'textScore' }]) {
      await run({ sort: { name: direction } }, 400);
    }
  });

  await namedCheck('select rejects invalid flags and expressions', async () => {
    for (const flag of [2, -1, '1', true, null, { $slice: 1 }]) {
      await run({ select: { name: flag } }, 400);
    }
  });

  await namedCheck('select rejects mixed inclusion and exclusion outside _id', async () => {
    await run({ select: { name: 1, dateCreated: 0 } }, 400);
  });

  await namedCheck('sort and select reject empty and unsafe field names', async () => {
    for (const field of ['', '$where', '__proto__', 'constructor', 'profile.$value', '+name', '-name']) {
      await run({ select: { [field]: 1 } }, 400);
      await run({ sort: { [field]: 1 } }, 400);
    }
    await run({ select: { name: 1, 'name.x': 1 } }, 400);
  });

  await namedCheck('skip rejects negative, fractional and wrong-type values', async () => {
    for (const skip of [-1, 0.5, '1', null, true, 9007199254740992]) await run({ skip }, 400);
  });

  await namedCheck('limit rejects negative, fractional and wrong-type values', async () => {
    for (const limit of [-1, 0.5, '1', null, true, 9007199254740992]) await run({ limit }, 400);
  });

  await namedCheck('count accepts only Boolean JSON values', async () => {
    for (const count of [0, 1, 'true', null, {}, []]) await run({ count }, 400);
  });

  await namedCheck('duplicate query parameters are rejected', async () => {
    const valid = { where: '{}', sort: '{}', select: '{}', skip: '0', limit: '1', count: 'false' };
    for (const [parameter, value] of Object.entries(valid)) {
      await raw([[parameter, value], [parameter, value]]);
    }
  });

  await namedCheck('count true still validates every other supplied parameter', async () => {
    for (const invalid of [
      { where: [] }, { sort: { name: 0 } }, { select: { name: 2 } }, { skip: -1 }, { limit: -1 }
    ]) await run({ count: true, ...invalid }, 400);
  });

  await namedCheck('single-resource select still works and ignores other list parameters', async () => {
    const select = { name: 1, _id: 0 };
    assert.deepEqual(await get(`${path}/${first._id}?${queryString({ select })}`), { name: first.name });
    const query = new URLSearchParams({
      where: '{', sort: '{', skip: '-bad', limit: '-bad', count: 'not-json', select: JSON.stringify(select)
    });
    assert.deepEqual(await get(`${path}/${first._id}?${query}`), { name: first.name });
  });

  await namedCheck('all six parameters preserve empty-list and zero-count results', async () => {
    const query = {
      where: missingWhere, sort: { _id: -1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 1
    };
    assert.deepEqual(await run({ ...query, count: false }), []);
    assert.equal(await run({ ...query, count: true }), 0);
  });

  await namedCheck('all users and tasks remain unchanged after the read-only checks', async () => {
    assert.deepEqual(await snapshot(), baseline);
  });
}

async function main() {
  const baseline = await snapshot();
  assert.ok(baseline.users.length >= 2, 'At least two users are required. Reuse the records from the earlier task smoke test.');
  assert.ok(baseline.tasks.length >= 2, 'At least two tasks are required. Reuse the records from the earlier task smoke test.');

  await checkCollection('users', baseline.users, baseline);
  await checkCollection('tasks', baseline.tasks, baseline);
  assert.equal(passed, 94);

  if (baseline.users.length <= 100 || baseline.tasks.length <= 100) {
    const collections = ['users', 'tasks'].filter(name => baseline[name].length <= 100);
    console.log(`NOTE: ${collections.join(' and ')} have at most 100 records; the >100 default-limit boundary is not exercised.`);
  }
  console.log('All 94 read-only list-query checks passed.');
  console.log('No users or tasks were created, updated, or deleted by this script.');
}

main().catch(error => {
  console.error(`FAIL after ${passed} passing checks: ${error.message}`);
  process.exitCode = 1;
});
