const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');

const apiUrl = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const prefix = `mp3-task-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const createdUsers = [];
const createdTasks = [];
let passed = 0;

async function request(method, path, body, raw = false) {
  const label = `${method} ${path}`;
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw new Error(`${label}: ${error.message}. Check that the server is running.`);
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${label}: HTTP ${response.status} did not return JSON: ${text.slice(0, 200)}`);
  }

  assert.ok(json && typeof json === 'object', `${label}: expected a JSON object`);
  assert.equal(typeof json.message, 'string', `${label}: missing message string`);
  assert.ok(json.message.length > 0, `${label}: message must not be empty`);
  assert.ok(Object.hasOwn(json, 'data'), `${label}: missing data field`);
  return { status: response.status, json, label };
}

function expectStatus(result, status) {
  assert.equal(
    result.status,
    status,
    `${result.label}: expected HTTP ${status}, got ${result.status}: ${JSON.stringify(result.json)}`
  );
}

async function list(path) {
  const result = await request('GET', path);
  expectStatus(result, 200);
  assert.ok(Array.isArray(result.json.data), `${result.label}: data must be an array`);
  return result.json.data;
}

async function visibleState() {
  const [users, tasks] = await Promise.all([list('/api/users'), list('/api/tasks')]);
  return {
    users: users.sort((a, b) => a._id.localeCompare(b._id)),
    tasks: tasks.sort((a, b) => a._id.localeCompare(b._id))
  };
}

async function expectRejected(body, status = 400, path = '/api/tasks', raw = false) {
  const before = await visibleState();
  const result = await request('POST', path, body, raw);
  expectStatus(result, status);
  assert.equal(result.json.data, null, `${result.label}: error data should be null`);
  assert.deepEqual(await visibleState(), before, `${result.label}: rejected request changed visible data`);
}

async function check(label, run) {
  await run();
  passed += 1;
  console.log(`PASS ${passed}/23: ${label}`);
}

function findDocument(documents, id, label) {
  const document = documents.find(item => item._id === id);
  assert.ok(document, `${label}: document ${id} was not returned`);
  return document;
}

function taskInput(overrides = {}) {
  return { name: `${prefix}-rejected`, deadline, ...overrides };
}

async function main() {
  let initialUsers;
  let initialTasks;
  let owner;
  let newOwner;
  let unassigned;
  let pending;
  let completed;

  await check('GET tasks returns an array, newest IDs first, with at most 100 results', async () => {
    [initialUsers, initialTasks] = await Promise.all([list('/api/users'), list('/api/tasks')]);
    assert.ok(initialTasks.length <= 100, 'GET /api/tasks: default limit must be 100');
    assert.deepEqual(
      initialTasks.map(task => task._id),
      initialTasks.map(task => task._id).sort().reverse(),
      'GET /api/tasks: expected descending _id order'
    );
  });

  await check('create the first test user', async () => {
    const result = await request('POST', '/api/users', {
      name: `${prefix}-owner`, email: `${prefix}-owner@example.com`
    });
    expectStatus(result, 201);
    owner = result.json.data;
    createdUsers.push(owner._id);
    assert.match(owner._id, /^[a-f0-9]{24}$/);
    assert.deepEqual(owner.pendingTasks, []);
  });

  await check('create an unassigned task with defaults and a server-generated creation date', async () => {
    const started = Date.now();
    const result = await request('POST', '/api/tasks', {
      name: `${prefix}-unassigned`, deadline, dateCreated: '2000-01-01T00:00:00.000Z'
    });
    expectStatus(result, 201);
    unassigned = result.json.data;
    createdTasks.push(unassigned._id);
    assert.match(unassigned._id, /^[a-f0-9]{24}$/);
    assert.equal(unassigned.name, `${prefix}-unassigned`);
    assert.equal(unassigned.description, '');
    assert.equal(unassigned.deadline, deadline);
    assert.equal(unassigned.completed, false);
    assert.equal(unassigned.assignedUser, '');
    assert.equal(unassigned.assignedUserName, 'unassigned');
    const createdAt = Date.parse(unassigned.dateCreated);
    assert.ok(createdAt >= started - 5000 && createdAt <= Date.now() + 5000);
  });

  await check('GET tasks includes the stored unassigned task', async () => {
    const tasks = await list('/api/tasks');
    assert.deepEqual(findDocument(tasks, unassigned._id, 'GET /api/tasks'), unassigned);
  });

  await check('create a pending task and infer its assigned user name', async () => {
    const result = await request('POST', '/api/tasks', {
      name: `${prefix}-pending`, description: 'Assigned pending smoke-test task',
      deadline, assignedUser: owner._id
    });
    expectStatus(result, 201);
    pending = result.json.data;
    createdTasks.push(pending._id);
    assert.equal(pending.assignedUser, owner._id);
    assert.equal(pending.assignedUserName, owner.name);
    assert.equal(pending.completed, false);
    assert.equal(pending.description, 'Assigned pending smoke-test task');
  });

  await check('the pending task appears in the assigned user pendingTasks', async () => {
    const user = findDocument(await list('/api/users'), owner._id, 'GET /api/users');
    assert.deepEqual(user.pendingTasks, [pending._id]);
  });

  await check('create a completed task that retains its assigned user', async () => {
    const result = await request('POST', '/api/tasks', {
      name: `${prefix}-completed`, deadline, completed: true,
      assignedUser: owner._id, assignedUserName: owner.name
    });
    expectStatus(result, 201);
    completed = result.json.data;
    createdTasks.push(completed._id);
    assert.equal(completed.completed, true);
    assert.equal(completed.assignedUser, owner._id);
    assert.equal(completed.assignedUserName, owner.name);
  });

  await check('completed assignment is stored but excluded from pendingTasks', async () => {
    const [users, tasks] = await Promise.all([list('/api/users'), list('/api/tasks')]);
    const user = findDocument(users, owner._id, 'GET /api/users');
    assert.deepEqual(user.pendingTasks, [pending._id]);
    assert.deepEqual(findDocument(tasks, completed._id, 'GET /api/tasks'), completed);
  });

  await check('missing task name returns 400 without changing visible data', async () => {
    await expectRejected({ deadline });
  });

  await check('missing deadline returns 400 without changing visible data', async () => {
    await expectRejected({ name: `${prefix}-missing-deadline` });
  });

  await check('blank and numeric task names return 400 without changes', async () => {
    for (const name of ['  ', 123]) await expectRejected(taskInput({ name }));
  });

  await check('invalid deadline values return 400 without changes', async () => {
    for (const invalid of ['not-a-date', null, {}, true]) {
      await expectRejected(taskInput({ deadline: invalid }));
    }
  });

  await check('a non-string description returns 400 without changes', async () => {
    await expectRejected(taskInput({ description: 123 }));
  });

  await check('a non-boolean completed value returns 400 without changes', async () => {
    await expectRejected(taskInput({ completed: 'true' }));
  });

  await check('a non-string assignedUser returns 400 without changes', async () => {
    await expectRejected(taskInput({ assignedUser: 123 }));
  });

  await check('a malformed assignedUser ID returns 400 without changes', async () => {
    await expectRejected(taskInput({ assignedUser: 'not-an-object-id' }));
  });

  await check('a valid but missing user ID returns 404 without changes', async () => {
    await expectRejected(taskInput({ assignedUser: randomBytes(12).toString('hex') }), 404);
  });

  await check('a non-string assignedUserName returns 400 without changes', async () => {
    await expectRejected(taskInput({ assignedUser: owner._id, assignedUserName: 123 }));
  });

  await check('an assigned user name mismatch returns 400 without changes', async () => {
    await expectRejected(taskInput({ assignedUser: owner._id, assignedUserName: `${prefix}-wrong-name` }));
  });

  await check('malformed JSON returns a JSON 400 response without changes', async () => {
    await expectRejected('{"name":', 400, '/api/tasks', true);
  });

  await check('an array request body returns 400 without changes', async () => {
    await expectRejected([]);
  });

  await check('a second user claims the unassigned task and takes over the pending task', async () => {
    const result = await request('POST', '/api/users', {
      name: `${prefix}-new-owner`, email: `${prefix}-new-owner@example.com`,
      pendingTasks: [unassigned._id, pending._id]
    });
    expectStatus(result, 201);
    newOwner = result.json.data;
    createdUsers.push(newOwner._id);
    assert.deepEqual([...newOwner.pendingTasks].sort(), [unassigned._id, pending._id].sort());
  });

  await check('both reference directions, completed ownership and final record counts are correct', async () => {
    const [users, tasks] = await Promise.all([list('/api/users'), list('/api/tasks')]);
    const oldUser = findDocument(users, owner._id, 'GET /api/users');
    const nextUser = findDocument(users, newOwner._id, 'GET /api/users');
    assert.deepEqual(oldUser.pendingTasks, []);
    assert.deepEqual([...nextUser.pendingTasks].sort(), [unassigned._id, pending._id].sort());
    for (const id of [unassigned._id, pending._id]) {
      const task = findDocument(tasks, id, 'GET /api/tasks');
      assert.equal(task.assignedUser, nextUser._id);
      assert.equal(task.assignedUserName, nextUser.name);
      assert.equal(task.completed, false);
    }
    const done = findDocument(tasks, completed._id, 'GET /api/tasks');
    assert.equal(done.assignedUser, oldUser._id);
    assert.equal(done.assignedUserName, oldUser.name);
    assert.equal(done.completed, true);
    assert.equal(users.length, initialUsers.length + 2);
    assert.equal(tasks.length, Math.min(initialTasks.length + 3, 100));
    assert.equal(users.filter(user => user.email.startsWith(prefix)).length, 2);
    assert.equal(tasks.filter(task => task.name.startsWith(prefix)).length, 3);
    assert.equal(createdUsers.length, 2);
    assert.equal(createdTasks.length, 3);
  });

  console.log('All 23 smoke checks passed.');
  console.log('Created 2 users and 3 tasks. They remain in your database.');
}

main().catch(error => {
  console.error(`FAIL after ${passed} passing checks: ${error.message}`);
  console.error(`Created so far: ${createdUsers.length} users and ${createdTasks.length} tasks. Test prefix: ${prefix}`);
  process.exitCode = 1;
});
