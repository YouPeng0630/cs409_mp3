const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');

const apiUrl = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const prefix = `mp3-put-test-${Date.now()}-${randomUUID().slice(0, 8)}`;
const deadline = new Date(Date.now() + 86400000).toISOString();
const users = [];
const tasks = [];
let passed = 0;

async function request(method, path, body, status = 200, raw = false) {
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
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
  assert.equal(response.status, status,
    `${method} ${path}: expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`);
  assert.equal(typeof json.message, 'string');
  assert.ok(Object.hasOwn(json, 'data'));
  if (status >= 400) assert.equal(json.data, null);
  return json.data;
}

async function list(collection, ids) {
  const query = new URLSearchParams({ sort: '{"_id":1}', limit: '0' });
  if (ids) query.set('where', JSON.stringify({ _id: { $in: ids } }));
  const data = await request('GET', `/api/${collection}?${query}`);
  assert.ok(Array.isArray(data));
  return data;
}

const read = (collection, index) => request('GET', `/api/${collection}/${(collection === 'users' ? users : tasks)[index]._id}`);
async function state() {
  const [currentUsers, currentTasks] = await Promise.all([
    list('users', users.map(user => user._id)), list('tasks', tasks.map(task => task._id))
  ]);
  return { users: currentUsers, tasks: currentTasks };
}

async function check(label, run) {
  await run();
  passed += 1;
  console.log(`PASS ${passed}/67: ${label}`);
}

async function update(collection, index, body) {
  const before = await read(collection, index);
  const data = await request('PUT', `/api/${collection}/${before._id}`, body);
  assert.equal(data._id, before._id, 'PUT must retain the original ID');
  assert.equal(data.dateCreated, before.dateCreated, 'PUT must retain dateCreated');
  assert.deepEqual(await read(collection, index), data, 'PUT response must match subsequent GET');
  return data;
}

async function taskPut(index, overrides = {}) {
  const current = await read('tasks', index);
  return update('tasks', index, { name: current.name, deadline: current.deadline, ...overrides });
}

async function userPut(index, overrides = {}) {
  const current = await read('users', index);
  return update('users', index, { name: current.name, email: current.email, ...overrides });
}

async function pending(userIndex, taskIndices) {
  const user = await read('users', userIndex);
  assert.deepEqual([...user.pendingTasks].sort(), taskIndices.map(index => tasks[index]._id).sort());
}

async function owner(taskIndex, userIndex, completed = false) {
  const task = await read('tasks', taskIndex);
  assert.equal(task.completed, completed);
  if (userIndex === null) {
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
  } else {
    const user = await read('users', userIndex);
    assert.equal(task.assignedUser, user._id);
    assert.equal(task.assignedUserName, user.name);
  }
  for (let index = 0; index < users.length; index += 1) {
    const user = await read('users', index);
    assert.equal(user.pendingTasks.includes(task._id), index === userIndex && !completed);
  }
}

async function reject(collection, id, body, status = 400, raw = false) {
  const before = await state();
  await request('PUT', `/api/${collection}/${id}`, body, status, raw);
  assert.deepEqual(await state(), before, 'Rejected PUT changed test records');
}

async function main() {
  let baseline;
  await check('capture existing records without changing them', async () => {
    const [currentUsers, currentTasks] = await Promise.all([list('users'), list('tasks')]);
    baseline = { users: currentUsers, tasks: currentTasks };
  });
  for (let index = 0; index < 3; index += 1) {
    await check(`create test user ${index + 1}`, async () => {
      users.push(await request('POST', '/api/users', {
        name: `${prefix}-user-${index}`, email: `${prefix}-user-${index}@example.com`
      }, 201));
    });
  }
  for (let index = 0; index < 5; index += 1) {
    await check(`create test task ${index + 1}`, async () => {
      const assignment = index === 1 || index === 2 ? users[0]._id : index === 3 ? users[1]._id : '';
      tasks.push(await request('POST', '/api/tasks', {
        name: `${prefix}-task-${index}`, deadline, description: 'Initial description',
        assignedUser: assignment, completed: index === 2
      }, 201));
    });
  }

  await check('assign an unassigned task and infer the user name', async () => {
    await taskPut(0, { assignedUser: users[0]._id, description: 'Assigned description' });
    await owner(0, 0);
  });
  await check('reassign a pending task and remove the old pending reference', async () => {
    await taskPut(0, { assignedUser: users[1]._id }); await owner(0, 1);
  });
  await check('complete a task while retaining its owner', async () => {
    await taskPut(0, { assignedUser: users[1]._id, completed: true }); await owner(0, 1, true);
  });
  await check('reopen a completed task and restore its pending reference', async () => {
    await taskPut(0, { assignedUser: users[1]._id, completed: false }); await owner(0, 1);
  });
  await check('a completed task may move to another user', async () => {
    await taskPut(0, { assignedUser: users[2]._id, completed: true }); await owner(0, 2, true);
  });
  await check('omitted completed and description reset to their defaults', async () => {
    const task = await taskPut(0, { assignedUser: users[2]._id });
    assert.equal(task.description, ''); await owner(0, 2);
  });
  await check('omitted assignedUser unassigns a previously assigned task', async () => {
    await taskPut(0); await owner(0, null);
  });
  await check('task PUT ignores client ID and creation date', async () => {
    await taskPut(1, { assignedUser: users[0]._id, _id: randomBytes(12).toString('hex'), dateCreated: '2000-01-01' });
    await owner(1, 0);
  });
  await check('user rename synchronizes pending and completed tasks', async () => {
    await userPut(0, { name: `${prefix}-renamed-a`, pendingTasks: [tasks[1]._id] });
    await owner(1, 0); await owner(2, 0, true);
  });
  await check('user PUT claims an unassigned task', async () => {
    await userPut(2, { pendingTasks: [tasks[0]._id] }); await owner(0, 2);
  });
  await check('user PUT transfers another user pending task', async () => {
    await userPut(2, { pendingTasks: [tasks[0]._id, tasks[3]._id] });
    await owner(3, 2); await pending(1, []);
  });
  await check('removing a pending task unassigns it', async () => {
    await userPut(2, { pendingTasks: [tasks[3]._id] }); await owner(0, null); await owner(3, 2);
  });
  await check('omitted pendingTasks clears the user pending list', async () => {
    await userPut(2); await pending(2, []); await owner(3, null);
  });
  await check('user PUT may claim multiple unassigned tasks', async () => {
    await userPut(1, { pendingTasks: [tasks[4]._id, tasks[3]._id] });
    await owner(4, 1); await owner(3, 1);
  });
  await check('user transfer preserves the old owner remaining tasks', async () => {
    await userPut(0, { pendingTasks: [tasks[1]._id, tasks[3]._id] });
    await owner(3, 0); await pending(1, [4]);
  });
  await check('pending IDs are normalized and deduplicated', async () => {
    await userPut(0, { pendingTasks: [tasks[1]._id, tasks[1]._id.toUpperCase(), tasks[3]._id] });
    await pending(0, [1, 3]);
  });
  await check('keeping the user own email is allowed', async () => {
    const user = await userPut(0, { pendingTasks: [tasks[1]._id, tasks[3]._id] });
    assert.equal(user.email, users[0].email);
  });
  await check('user replacement changes email and ignores client ID/date', async () => {
    const user = await userPut(0, {
      name: `${prefix}-renamed-again-a`, email: `${prefix}-changed@example.com`,
      pendingTasks: [tasks[1]._id, tasks[3]._id],
      _id: randomBytes(12).toString('hex'), dateCreated: '2000-01-01'
    });
    assert.equal(user.email, `${prefix}-changed@example.com`); await owner(2, 0, true);
  });
  await check('an already completed task may be reassigned with a matching name', async () => {
    const user = await read('users', 1);
    await taskPut(2, { assignedUser: user._id, assignedUserName: user.name, completed: true });
    await owner(2, 1, true);
  });
  await check('reopening the moved task adds it to its new owner', async () => {
    await taskPut(2, { assignedUser: users[1]._id, completed: false }); await owner(2, 1);
  });
  await check('full task replacement retains required values and resets optional values', async () => {
    const task = await taskPut(2, { assignedUser: users[1]._id });
    assert.equal(task.description, ''); assert.equal(task.completed, false); await owner(2, 1);
  });
  await check('a completed task may be explicitly unassigned', async () => {
    await taskPut(2, { assignedUser: '', assignedUserName: 'unassigned', completed: true });
    await owner(2, null, true);
  });
  await check('a completed unassigned task may gain an owner without becoming pending', async () => {
    await taskPut(2, { assignedUser: users[0]._id, completed: true }); await owner(2, 0, true);
  });
  await check('clearing pendingTasks retains completed ownership and synchronizes its name', async () => {
    await userPut(0, { name: `${prefix}-final-a` });
    await pending(0, []); await owner(1, null); await owner(3, null); await owner(2, 0, true);
  });

  const taskId = tasks[4]._id;
  const userId = users[0]._id;
  const missingTask = randomBytes(12).toString('hex');
  const missingUser = randomBytes(12).toString('hex');
  const taskBody = { name: `${prefix}-rejected-task`, deadline };
  const currentUser = await read('users', 0);
  const userBody = { name: currentUser.name, email: currentUser.email };
  const badTask = (body, status = 400, id = taskId, raw = false) => reject('tasks', id, body, status, raw);
  const badUser = (body, status = 400, id = userId, raw = false) => reject('users', id, body, status, raw);

  await check('task requires name on every PUT', () => badTask({ deadline }));
  await check('task requires deadline on every PUT', () => badTask({ name: taskBody.name }));
  await check('numeric task name returns 400', () => badTask({ ...taskBody, name: 123 }));
  await check('blank task name returns 400', () => badTask({ ...taskBody, name: '  ' }));
  await check('invalid deadline values return 400', async () => {
    for (const value of ['not-a-date', null, {}, true]) await badTask({ ...taskBody, deadline: value });
  });
  await check('non-string description returns 400', () => badTask({ ...taskBody, description: 123 }));
  await check('non-boolean completed returns 400', () => badTask({ ...taskBody, completed: 'true' }));
  await check('non-string assignedUser returns 400', () => badTask({ ...taskBody, assignedUser: 123 }));
  await check('malformed assignedUser ID returns 400', () => badTask({ ...taskBody, assignedUser: 'bad-id' }));
  await check('missing referenced user returns 404', () => badTask({ ...taskBody, assignedUser: missingUser }, 404));
  await check('non-string assignedUserName returns 400', () => badTask({ ...taskBody, assignedUserName: 123 }));
  await check('assigned user name mismatch returns 400', () => badTask({ ...taskBody, assignedUser: userId, assignedUserName: 'wrong-name' }));
  await check('unassigned task cannot retain a user name', () => badTask({ ...taskBody, assignedUserName: 'wrong-name' }));
  await check('array task body returns 400', () => badTask([]));
  await check('malformed task JSON returns 400', () => badTask('{"name":', 400, taskId, true));
  await check('missing task URL returns 404', () => badTask(taskBody, 404, missingTask));
  await check('malformed task URL returns 404', () => badTask(taskBody, 404, 'invalid-id'));
  await check('missing task URL takes precedence over invalid fields', () => badTask({}, 404, missingTask));
  await check('invalid task fields take precedence over missing user references', () => badTask({ ...taskBody, completed: 'true', assignedUser: missingUser }));
  await check('user requires name on every PUT', () => badUser({ email: userBody.email }));
  await check('user requires email on every PUT', () => badUser({ name: userBody.name }));
  await check('user string fields reject wrong types and blank values', async () => {
    for (const change of [{ name: 123 }, { email: 123 }, { name: ' ' }, { email: ' ' }]) await badUser({ ...userBody, ...change });
  });
  await check('pendingTasks must be an array', async () => {
    for (const pendingTasks of [null, 'bad', {}]) await badUser({ ...userBody, pendingTasks });
  });
  await check('malformed pending task IDs return 400', () => badUser({ ...userBody, pendingTasks: ['invalid-id'] }));
  await check('missing referenced task returns 404', () => badUser({ ...userBody, pendingTasks: [missingTask] }, 404));
  await check('completed tasks cannot enter pendingTasks', () => badUser({ ...userBody, pendingTasks: [tasks[2]._id] }));
  await check('email used by another user returns 400', () => badUser({ ...userBody, email: users[1].email }));
  await check('malformed user URL takes precedence over invalid fields', () => badUser({}, 404, 'invalid-id'));
  await check('missing user URL takes precedence over invalid fields', () => badUser({}, 404, missingUser));
  await check('invalid user fields take precedence over missing task references', () => badUser({ ...userBody, name: 123, pendingTasks: [missingTask] }));
  await check('completed task validation takes precedence over a missing reference', () => badUser({ ...userBody, pendingTasks: [tasks[2]._id, missingTask] }));
  await check('array and malformed JSON user bodies return 400', async () => {
    await badUser([]); await badUser('{"name":', 400, userId, true);
  });

  await check('final user-task references agree in both directions', async () => {
    const final = await state();
    for (const user of final.users) {
      assert.equal(new Set(user.pendingTasks).size, user.pendingTasks.length);
      const expected = final.tasks.filter(task => !task.completed && task.assignedUser === user._id).map(task => task._id).sort();
      assert.deepEqual([...user.pendingTasks].sort(), expected);
    }
    for (const task of final.tasks) {
      if (task.assignedUser === '') assert.equal(task.assignedUserName, 'unassigned');
      else {
        const user = final.users.find(candidate => candidate._id === task.assignedUser);
        assert.ok(user); assert.equal(task.assignedUserName, user.name);
      }
    }
  });
  await check('original records are unchanged and exactly three users/five tasks were created', async () => {
    const [allUsers, allTasks] = await Promise.all([list('users'), list('tasks')]);
    const userIds = new Set(users.map(user => user._id));
    const taskIds = new Set(tasks.map(task => task._id));
    assert.deepEqual(allUsers.filter(user => !userIds.has(user._id)), baseline.users);
    assert.deepEqual(allTasks.filter(task => !taskIds.has(task._id)), baseline.tasks);
    assert.equal(allUsers.length, baseline.users.length + 3);
    assert.equal(allTasks.length, baseline.tasks.length + 5);
    for (const user of users) assert.equal(allUsers.find(item => item._id === user._id).dateCreated, user.dateCreated);
    for (const task of tasks) assert.equal(allTasks.find(item => item._id === task._id).dateCreated, task.dateCreated);
  });

  assert.equal(passed, 67);
  console.log('All 67 PUT checks passed.');
  console.log('Created 3 users and 5 tasks. They remain in your database.');
}

main().catch(error => {
  console.error(`FAIL after ${passed} passing checks: ${error.message}`);
  console.error(`Created so far: ${users.length} users and ${tasks.length} tasks. Test prefix: ${prefix}`);
  process.exitCode = 1;
});
