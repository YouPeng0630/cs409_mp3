const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const makeGetById = require('../utils/get-by-id');
const makeListQuery = require('../utils/list-query');
const { putTask } = require('../utils/put-handlers');
const { deleteTask } = require('../utils/delete-handlers');

const router = express.Router();

// GET /api/tasks
router.get('/', makeListQuery(Task, {
  defaultLimit: 100,
  resourceName: 'tasks',
  defaultSort: { _id: -1 }
}));

function createTaskError(status, message) {
  const error = new Error(message);
  error.apiStatus = status;
  return error;
}

// POST /api/tasks
router.post('/', async function (req, res) {
  const fail = (status, message) => {
    return res.status(status).json({
      message,
      data: null
    });
  };

  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'Request body must be an object.');
  }

  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return fail(400, 'Name must be a non-empty string.');
  }

  // JSON dates may be date strings or numeric milliseconds since the epoch.
  if (
    !(
      (typeof body.deadline === 'string' && body.deadline.trim() !== '') ||
      (typeof body.deadline === 'number' && Number.isFinite(body.deadline))
    )
  ) {
    return fail(400, 'Deadline must be a valid date.');
  }

  const deadline = new Date(body.deadline);
  if (Number.isNaN(deadline.getTime())) {
    return fail(400, 'Deadline must be a valid date.');
  }

  const description = body.description === undefined ? '' : body.description;
  if (typeof description !== 'string') {
    return fail(400, 'Description must be a string.');
  }

  const completed = body.completed === undefined ? false : body.completed;
  if (typeof completed !== 'boolean') {
    return fail(400, 'Completed must be a boolean.');
  }

  const assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
  if (
    typeof assignedUser !== 'string' ||
    (assignedUser !== '' && !/^[a-fA-F0-9]{24}$/.test(assignedUser))
  ) {
    return fail(400, 'Assigned user must be empty or a valid user ID.');
  }

  if (
    body.assignedUserName !== undefined &&
    typeof body.assignedUserName !== 'string'
  ) {
    return fail(400, 'Assigned user name must be a string.');
  }

  if (
    assignedUser === '' &&
    body.assignedUserName !== undefined &&
    body.assignedUserName !== 'unassigned'
  ) {
    return fail(400, 'Unassigned tasks must use the name "unassigned".');
  }

  const assignedUserId = assignedUser.toLowerCase();

  try {
    await User.init();
    await Task.init();

    const createdTask = await Task.db.transaction(async session => {
      let user = null;

      if (assignedUserId !== '') {
        user = await User.findById(assignedUserId).session(session);

        if (!user) {
          throw createTaskError(404, 'Assigned user does not exist.');
        }

        if (
          body.assignedUserName !== undefined &&
          body.assignedUserName !== user.name
        ) {
          throw createTaskError(400, 'Assigned user name does not match the user.');
        }
      }

      // Ignore client IDs and dateCreated; the server owns those fields.
      const task = new Task({
        name: body.name.trim(),
        description,
        deadline,
        completed,
        assignedUser: assignedUserId,
        assignedUserName: user ? user.name : 'unassigned'
      });

      await task.save({ session });

      // Completed tasks stay assigned but never enter a user's pendingTasks.
      if (user && !completed) {
        await User.updateOne(
          { _id: user._id },
          { $addToSet: { pendingTasks: task._id.toString() } },
          { session, runValidators: true }
        );
      }

      return task.toObject();
    });

    return res.status(201).json({
      message: 'Task created.',
      data: createdTask
    });
  } catch (err) {
    if (err.apiStatus) {
      return fail(err.apiStatus, err.message);
    }

    if (err.name === 'ValidationError' || err.name === 'CastError') {
      return fail(400, 'Invalid task data.');
    }

    console.error('Failed to create task:', err.message);

    return fail(500, 'Unable to create task.');
  }
});

// GET /api/tasks/:id
router.get('/:id', makeGetById(Task, 'Task'));

// PUT /api/tasks/:id
router.put('/:id', putTask);

// DELETE /api/tasks/:id
router.delete('/:id', deleteTask);

module.exports = router;
