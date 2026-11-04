const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');

const apiUrl = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const prefix = `mp3-delete-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
const deadline = new Date(Date.now() + 86400000).toISOString();
const users = [];
const tasks = [];
let passed = 0;

async function request(method, path, body, expectedStatus = 200) {
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw new Error(`${method} ${path}: ${error.message}. Check that the server is running.`);
  }

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`${method} ${path}: HTTP ${response.status} did not return JSON: ${text.slice(0, 200)}`);
  }
  assert.equal(response.status, expectedStatus,
    `${method} ${path}: expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(json)}`);
  assert.ok(json && typeof json === 'object' && !Array.isArray(json));
  assert.equal(typeof json.message, 'string');
  assert.ok(json.message.length > 0);
  assert.ok(Object.hasOwn(json, 'data'));
  if (expectedStatus >= 400) assert.equal(json.data, null);
  return json.data;
}

function fixture(collection, index) {
  return (collection === 'users' ? users : tasks)[index];
}

function path(collection, id) {
  return `/api/${collection}/${encodeURIComponent(id)}`;
}

const read = (collection, index) => request('GET', path(collection, fixture(collection, index)._id));

async function list(collection, ids, count = false) {
  const query = new URLSearchParams({ sort: '{"_id":1}', limit: '0' });
  if (ids) query.set('where', JSON.stringify({ _id: { $in: ids } }));
  if (count) query.set('count', 'true');
  const data = await request('GET', `/api/${collection}?${query}`);
  if (!count) assert.ok(Array.isArray(data));
  return data;
}

async function state() {
  const [currentUsers, currentTasks] = await Promise.all([list('users'), list('tasks')]);
  return { users: currentUsers, tasks: currentTasks };
}

async function check(label, run) {
  await run();
  passed += 1;
  console.log(`PASS ${passed}/30: ${label}`);
}

// Every successful DELETE is guarded by an ID obtained from this run's POSTs.
async function deleteOwned(collection, index, uppercase = false) {
  const record = fixture(collection, index);
  assert.ok(record && /^[a-f0-9]{24}$/.test(record._id), 'Cleanup target must be an owned fixture ID');
  const before = await read(collection, index);
  const id = uppercase ? record._id.toUpperCase() : record._id;
  const deleted = await request('DELETE', path(collection, id));
  assert.deepEqual(deleted, before, 'DELETE data must contain the resource before deletion');
  return deleted;
}

async function rejectedDelete(collection, id) {
  const before = await state();
  await request('DELETE', path(collection, id), undefined, 404);
  assert.deepEqual(await state(), before, 'Rejected DELETE changed visible records');
}

async function main() {
  let baseline;
  let otherUser;
  let otherTask;
  let orphanPending;
  let orphanCompleted;

  await check('capture the original users and tasks', async () => {
    baseline = await state();
  });

  for (let index = 0; index < 3; index += 1) {
    await check(`create test user ${index + 1}`, async () => {
      users.push(await request('POST', '/api/users', {
        name: `${prefix}-user-${index}`, email: `${prefix}-user-${index}@example.com`
      }, 201));
      assert.match(users[index]._id, /^[a-f0-9]{24}$/);
    });
  }

  for (let index = 0; index < 6; index += 1) {
    await check(`create test task ${index + 1}`, async () => {
      const assignedUser = index <= 2 ? users[0]._id : index <= 4 ? users[1]._id : '';
      tasks.push(await request('POST', '/api/tasks', {
        name: `${prefix}-task-${index}`, description: `Description ${index}`, deadline,
        assignedUser, completed: index === 2 || index === 4
      }, 201));
      assert.match(tasks[index]._id, /^[a-f0-9]{24}$/);
    });
  }

  await check('delete a pending task and remove its user reference', async () => {
    await deleteOwned('tasks', 0);
    const owner = await read('users', 0);
    assert.deepEqual(owner.pendingTasks, [tasks[1]._id]);
    assert.equal(owner.dateCreated, users[0].dateCreated);
  });

  await check('the deleted task is absent from single, list and count queries', async () => {
    await request('GET', path('tasks', tasks[0]._id), undefined, 404);
    assert.deepEqual(await list('tasks', [tasks[0]._id]), []);
    assert.equal(await list('tasks', [tasks[0]._id], true), 0);
    assert.equal((await list('tasks')).length, baseline.tasks.length + 5);
  });

  await check('deleting the same task again returns 404 without changes', async () => {
    await rejectedDelete('tasks', tasks[0]._id);
  });

  await check('delete a completed task without changing its owner pending list', async () => {
    const before = await read('users', 1);
    await deleteOwned('tasks', 4);
    assert.deepEqual(await read('users', 1), before);
    await request('GET', path('tasks', tasks[4]._id), undefined, 404);
  });

  await check('delete an unassigned task without changing any users', async () => {
    const before = await list('users');
    await deleteOwned('tasks', 5);
    assert.deepEqual(await list('users'), before);
    await request('GET', path('tasks', tasks[5]._id), undefined, 404);
    assert.equal(await list('tasks', tasks.map(task => task._id), true), 3);
  });

  const knownIds = new Set([
    ...baseline.users, ...baseline.tasks, ...users, ...tasks
  ].map(record => record._id));
  let missingId;
  do { missingId = randomBytes(12).toString('hex'); } while (knownIds.has(missingId));

  await check('malformed and nonexistent task IDs return 404 without changes', async () => {
    for (const id of ['invalid-id', 'g'.repeat(24), missingId]) await rejectedDelete('tasks', id);
  });

  await check('malformed and nonexistent user IDs return 404 without changes', async () => {
    for (const id of ['invalid-id', 'g'.repeat(24), missingId]) await rejectedDelete('users', id);
  });

  await check('delete a user that has no tasks', async () => {
    const before = await list('tasks');
    await deleteOwned('users', 2);
    assert.deepEqual(await list('tasks'), before);
  });

  await check('the empty user is gone and a repeated deletion returns 404', async () => {
    await request('GET', path('users', users[2]._id), undefined, 404);
    await rejectedDelete('users', users[2]._id);
  });

  await check('delete a user that owns both pending and completed tasks', async () => {
    otherUser = await read('users', 1);
    otherTask = await read('tasks', 3);
    orphanPending = await read('tasks', 1);
    orphanCompleted = await read('tasks', 2);
    const taskCount = await list('tasks', undefined, true);
    const deleted = await deleteOwned('users', 0);
    assert.deepEqual(deleted.pendingTasks, [tasks[1]._id]);
    assert.equal(await list('tasks', undefined, true), taskCount, 'Deleting a user must retain its tasks');
  });

  await check('the retained pending task is unassigned and otherwise unchanged', async () => {
    assert.deepEqual(await read('tasks', 1), {
      ...orphanPending, assignedUser: '', assignedUserName: 'unassigned'
    });
  });

  await check('the retained completed task is unassigned and otherwise unchanged', async () => {
    assert.deepEqual(await read('tasks', 2), {
      ...orphanCompleted, assignedUser: '', assignedUserName: 'unassigned'
    });
  });

  await check('no task points to the deleted user and the other owner is unchanged', async () => {
    const remainingTasks = await list('tasks');
    assert.equal(remainingTasks.some(task => task.assignedUser === users[0]._id), false);
    assert.deepEqual(await read('users', 1), otherUser);
    assert.deepEqual(await read('tasks', 3), otherTask);
  });

  await check('the deleted owner is absent from queries and cannot be deleted twice', async () => {
    await request('GET', path('users', users[0]._id), undefined, 404);
    assert.deepEqual(await list('users', [users[0]._id]), []);
    assert.equal(await list('users', [users[0]._id], true), 0);
    await rejectedDelete('users', users[0]._id);
  });

  await check('delete only this run retained orphan tasks', async () => {
    await deleteOwned('tasks', 1);
    await deleteOwned('tasks', 2);
    assert.deepEqual(await read('users', 1), otherUser);
  });

  await check('uppercase task IDs work and the last owner reference is removed', async () => {
    await deleteOwned('tasks', 3, true);
    const remainingOwner = await read('users', 1);
    assert.deepEqual(remainingOwner, { ...otherUser, pendingTasks: [] });
  });

  await check('delete the final test user using an uppercase ID', async () => {
    await deleteOwned('users', 1, true);
  });

  await check('every created user and task now returns 404', async () => {
    for (const collection of ['users', 'tasks']) {
      for (const record of collection === 'users' ? users : tasks) {
        await request('GET', path(collection, record._id), undefined, 404);
      }
    }
  });

  await check('scoped fixture lists are empty and their counts are zero', async () => {
    for (const [collection, records] of [['users', users], ['tasks', tasks]]) {
      const ids = records.map(record => record._id);
      assert.deepEqual(await list(collection, ids), []);
      assert.equal(await list(collection, ids, true), 0);
    }
  });

  await check('all original records and total counts are unchanged', async () => {
    assert.deepEqual(await state(), baseline);
    assert.equal(await list('users', undefined, true), baseline.users.length);
    assert.equal(await list('tasks', undefined, true), baseline.tasks.length);
    assert.equal(users.length, 3);
    assert.equal(tasks.length, 6);
  });

  assert.equal(passed, 30);
  console.log('All 30 DELETE checks passed.');
  console.log("Created 3 users and 6 tasks; all this run's fixtures were deleted.");
  console.log('Records from before this test run were not cleanup targets.');
}

main().catch(error => {
  console.error(`FAIL after ${passed} passing checks: ${error.message}`);
  console.error(`Test prefix: ${prefix}`);
  console.error(`Created user IDs: ${JSON.stringify(users.map(user => user._id))}`);
  console.error(`Created task IDs: ${JSON.stringify(tasks.map(task => task._id))}`);
  process.exitCode = 1;
});
