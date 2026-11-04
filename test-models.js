const assert = require('node:assert/strict');
const User = require('./models/user');
const Task = require('./models/task');

// Check valid users and their default values without connecting to a database.
const user = new User({
  name: 'Test User',
  email: 'test@example.com'
});

assert.equal(user.validateSync(), undefined);
assert.deepEqual(Array.from(user.pendingTasks), []);
assert.ok(user.dateCreated instanceof Date);

console.log('PASS: User fields and defaults');

const userError = new User({}).validateSync();

assert.ok(userError?.errors?.name);
assert.ok(userError?.errors?.email);

console.log('PASS: User required fields');

const task = new Task({
  name: 'Test Task',
  deadline: new Date('2026-12-01T12:00:00Z')
});

assert.equal(task.validateSync(), undefined);
assert.equal(task.description, '');
assert.equal(task.completed, false);
assert.equal(task.assignedUser, '');
assert.equal(task.assignedUserName, 'unassigned');
assert.ok(task.dateCreated instanceof Date);

console.log('PASS: Task fields and defaults');

const taskError = new Task({}).validateSync();

assert.ok(taskError?.errors?.name);
assert.ok(taskError?.errors?.deadline);

console.log('PASS: Task required fields');

console.log('All model checks passed.');
