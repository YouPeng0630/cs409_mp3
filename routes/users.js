const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const makeGetById = require('../utils/get-by-id');
const makeListQuery = require('../utils/list-query');
const { putUser } = require('../utils/put-handlers');
const { deleteUser } = require('../utils/delete-handlers');

const router = express.Router();

// GET /api/users
router.get('/', makeListQuery(User, {
  defaultLimit: 0,
  resourceName: 'users'
}));

function createUserError(status, message) {
  const error = new Error(message);
  error.apiStatus = status;
  return error;
}

// POST /api/users
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

  // Validate the original types before Mongoose can cast the values.
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return fail(400, 'Name must be a non-empty string.');
  }

  if (typeof body.email !== 'string' || body.email.trim() === '') {
    return fail(400, 'Email must be a non-empty string.');
  }

  const name = body.name.trim();
  const email = body.email.trim();
  const pendingTasks =
    body.pendingTasks === undefined ? [] : body.pendingTasks;

  if (!Array.isArray(pendingTasks)) {
    return fail(400, 'pendingTasks must be an array.');
  }

  const validTaskIds = pendingTasks.every(
    id => typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id)
  );

  if (!validTaskIds) {
    return fail(400, 'pendingTasks contains an invalid task ID.');
  }

  const taskIds = [
    ...new Set(pendingTasks.map(id => id.toLowerCase()))
  ];

  try {
    // Prepare collections and the unique email index before starting a transaction.
    await User.init();
    await Task.init();

    const createdUser = await User.db.transaction(async session => {
      const existingUser = await User.findOne({ email })
        .session(session);

      if (existingUser) {
        throw createUserError(400, 'Email is already in use.');
      }

      const tasks = await Task.find({
        _id: { $in: taskIds }
      }).session(session);

      if (tasks.some(task => task.completed)) {
        throw createUserError(
          400,
          'Completed tasks cannot be included in pendingTasks.'
        );
      }

      if (tasks.length !== taskIds.length) {
        throw createUserError(
          404,
          'One or more referenced tasks do not exist.'
        );
      }

      // Accept only client-editable fields; the server sets dateCreated.
      const user = new User({
        name,
        email,
        pendingTasks: taskIds
      });

      await user.save({ session });

      if (taskIds.length > 0) {
        await User.updateMany(
          {
            _id: { $ne: user._id },
            pendingTasks: { $in: taskIds }
          },
          {
            $pull: {
              pendingTasks: { $in: taskIds }
            }
          },
          { session }
        );

        await Task.updateMany(
          { _id: { $in: taskIds } },
          {
            $set: {
              assignedUser: user._id.toString(),
              assignedUserName: user.name
            }
          },
          {
            session,
            runValidators: true
          }
        );
      }

      return user.toObject();
    });

    return res.status(201).json({
      message: 'User created.',
      data: createdUser
    });
  } catch (err) {
    if (err.apiStatus) {
      return fail(err.apiStatus, err.message);
    }

    // The unique index also protects concurrent requests using the same email.
    if (err.code === 11000) {
      return fail(400, 'Email is already in use.');
    }

    if (
      err.name === 'ValidationError' ||
      err.name === 'CastError'
    ) {
      return fail(400, 'Invalid user data.');
    }

    console.error('Failed to create user:', err.message);

    return fail(500, 'Unable to create user.');
  }
});

// GET /api/users/:id
router.get('/:id', makeGetById(User, 'User'));

// PUT /api/users/:id
router.put('/:id', putUser);

// DELETE /api/users/:id
router.delete('/:id', deleteUser);

module.exports = router;
