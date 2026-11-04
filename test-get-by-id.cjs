const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const apiUrl = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
let passed = 0;

// This script deliberately uses only GET requests and existing records.
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
    response.status,
    expectedStatus,
    `GET ${path}: expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`
  );
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `GET ${path}: expected a JSON object`);
  assert.equal(typeof body.message, 'string', `GET ${path}: missing message string`);
  assert.ok(body.message.length > 0, `GET ${path}: message must not be empty`);
  assert.ok(Object.hasOwn(body, 'data'), `GET ${path}: missing data field`);
  if (expectedStatus >= 400) assert.equal(body.data, null, `GET ${path}: error data should be null`);
  return body.data;
}

async function list(path) {
  const documents = await get(path);
  assert.ok(Array.isArray(documents), `GET ${path}: data must be an array`);
  return documents;
}

async function visibleState() {
  const [users, tasks] = await Promise.all([list('/api/users'), list('/api/tasks')]);
  return {
    users: users.sort((a, b) => a._id.localeCompare(b._id)),
    tasks: tasks.sort((a, b) => a._id.localeCompare(b._id))
  };
}

async function check(label, run) {
  await run();
  passed += 1;
  console.log(`PASS ${passed}/44: ${label}`);
}

function without(document, ...fields) {
  return Object.fromEntries(Object.entries(document).filter(([key]) => !fields.includes(key)));
}

async function checkResource(collection, original, baseline) {
  const path = `/api/${collection}`;
  const id = original._id;
  const missingId = randomBytes(12).toString('hex');
  const otherField = collection === 'users' ? 'email' : 'deadline';
  const missingField = 'fieldThatDoesNotExistForReadOnlyTest';
  const single = (query = '', status = 200, resourceId = id) =>
    get(`${path}/${encodeURIComponent(resourceId)}${query ? `?${query}` : ''}`, status);
  const selectQuery = projection => new URLSearchParams({ select: JSON.stringify(projection) }).toString();
  const selected = (projection, status = 200, resourceId = id) => single(selectQuery(projection), status, resourceId);
  const namedCheck = (label, run) => check(`${collection}: ${label}`, run);

  await namedCheck('existing ID returns the complete resource as an object', async () => {
    const document = await single();
    assert.ok(document && typeof document === 'object' && !Array.isArray(document));
    assert.deepEqual(document, original);
  });

  await namedCheck('uppercase hexadecimal ID still returns the same resource', async () => {
    assert.deepEqual(await single('', 200, id.toUpperCase()), original);
  });

  await namedCheck('a well-formed missing ID returns 404', async () => {
    await single('', 404, missingId);
  });

  await namedCheck('malformed IDs return 404', async () => {
    for (const invalidId of ['not-an-id', '123', 'g'.repeat(24)]) {
      await single('', 404, invalidId);
    }
  });

  await namedCheck('inclusion projection keeps name and the default _id', async () => {
    assert.deepEqual(await selected({ name: 1 }), { _id: id, name: original.name });
  });

  await namedCheck('inclusion projection can select two fields and exclude _id', async () => {
    assert.deepEqual(await selected({ name: 1, [otherField]: 1, _id: 0 }), {
      name: original.name,
      [otherField]: original[otherField]
    });
  });

  await namedCheck('exclusion projection removes name and keeps other fields', async () => {
    assert.deepEqual(await selected({ name: 0 }), without(original, 'name'));
  });

  await namedCheck('selecting only _id returns only _id', async () => {
    assert.deepEqual(await selected({ _id: 1 }), { _id: id });
  });

  await namedCheck('excluding only _id returns the remaining fields', async () => {
    assert.deepEqual(await selected({ _id: 0 }), without(original, '_id'));
  });

  await namedCheck('an empty projection returns the complete resource', async () => {
    assert.deepEqual(await selected({}), original);
  });

  await namedCheck('an unknown field with _id excluded returns an empty object', async () => {
    assert.deepEqual(await selected({ [missingField]: 1, _id: 0 }), {});
  });

  await namedCheck('invalid JSON in select returns 400', async () => {
    for (const value of ['{', '']) {
      await single(new URLSearchParams({ select: value }).toString(), 400);
    }
  });

  await namedCheck('non-object select values return 400', async () => {
    for (const value of [null, [], 1, 'name', true]) await selected(value, 400);
  });

  await namedCheck('invalid projection flags and expressions return 400', async () => {
    for (const value of [2, -1, '1', true, null, { $slice: 1 }]) {
      await selected({ name: value }, 400);
    }
  });

  await namedCheck('mixed inclusion and exclusion outside _id returns 400', async () => {
    await selected({ name: 1, dateCreated: 0 }, 400);
  });

  await namedCheck('duplicate select parameters return 400', async () => {
    const query = new URLSearchParams([
      ['select', '{"name":1}'],
      ['select', '{"name":0}']
    ]).toString();
    await single(query, 400);
  });

  await namedCheck('empty and unsafe projection field names return 400', async () => {
    for (const field of ['', '$where', '__proto__', 'constructor', 'profile.$value', '+name', '-name']) {
      await selected({ [field]: 1 }, 400);
    }
    await selected({ name: 1, 'name.x': 1 }, 400);
  });

  const ignoredParameters = {
    where: JSON.stringify({ _id: missingId }),
    sort: '{',
    skip: 'not-a-number',
    limit: '-invalid',
    count: 'not-json'
  };

  await namedCheck('where, sort, skip, limit and count are ignored even when invalid', async () => {
    assert.deepEqual(await single(new URLSearchParams(ignoredParameters).toString()), original);
  });

  await namedCheck('ignored query parameters do not interfere with valid select', async () => {
    const query = new URLSearchParams({
      ...ignoredParameters,
      select: JSON.stringify({ name: 1, _id: 0 })
    }).toString();
    assert.deepEqual(await single(query), { name: original.name });
  });

  await namedCheck('a missing resource stays 404 when a projection would hide all fields', async () => {
    await selected({ [missingField]: 1, _id: 0 }, 404, missingId);
  });

  await namedCheck('an invalid path ID takes precedence over invalid select JSON', async () => {
    await single(new URLSearchParams({ select: '{' }).toString(), 404, 'invalid-id');
  });

  await namedCheck('all visible users and tasks are unchanged after the GET checks', async () => {
    assert.deepEqual(await visibleState(), baseline);
  });
}

async function main() {
  const baseline = await visibleState();
  assert.ok(baseline.users.length > 0, 'No users found. Create at least one user before running this read-only script.');
  assert.ok(baseline.tasks.length > 0, 'No tasks found. Create at least one task before running this read-only script.');

  await checkResource('users', baseline.users[0], baseline);
  await checkResource('tasks', baseline.tasks[0], baseline);
  assert.equal(passed, 44);

  console.log('All 44 read-only checks passed.');
  console.log('No users or tasks were created, updated, or deleted by this script.');
}

main().catch(error => {
  console.error(`FAIL after ${passed} passing checks: ${error.message}`);
  process.exitCode = 1;
});
