const User = require('../models/user');
const Task = require('../models/task');

function apiError(status, message) {
  const error = new Error(message);
  error.apiStatus = status;
  return error;
}

function isId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw apiError(400, 'Request body must be an object.');
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw apiError(400, `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function userFields(body) {
  requireBody(body);
  const name = requiredString(body.name, 'Name');
  const email = requiredString(body.email, 'Email');
  const pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;

  if (!Array.isArray(pendingTasks)) {
    throw apiError(400, 'pendingTasks must be an array.');
  }
  if (!pendingTasks.every(isId)) {
    throw apiError(400, 'pendingTasks contains an invalid task ID.');
  }

  return {
    name,
    email,
    pendingTasks: [...new Set(pendingTasks.map(id => id.toLowerCase()))]
  };
}

function taskFields(body) {
  requireBody(body);
  const name = requiredString(body.name, 'Name');

  if (!(
    (typeof body.deadline === 'string' && body.deadline.trim() !== '') ||
    (typeof body.deadline === 'number' && Number.isFinite(body.deadline))
  )) {
    throw apiError(400, 'Deadline must be a valid date.');
  }

  const deadline = new Date(body.deadline);
  if (Number.isNaN(deadline.getTime())) {
    throw apiError(400, 'Deadline must be a valid date.');
  }

  const description = body.description === undefined ? '' : body.description;
  if (typeof description !== 'string') {
    throw apiError(400, 'Description must be a string.');
  }

  const completed = body.completed === undefined ? false : body.completed;
  if (typeof completed !== 'boolean') {
    throw apiError(400, 'Completed must be a boolean.');
  }

  const assignedUser = body.assignedUser === undefined ? '' : body.assignedUser;
  if (assignedUser !== '' && !isId(assignedUser)) {
    throw apiError(400, 'Assigned user must be empty or a valid user ID.');
  }
  if (body.assignedUserName !== undefined && typeof body.assignedUserName !== 'string') {
    throw apiError(400, 'Assigned user name must be a string.');
  }
  if (
    assignedUser === '' && body.assignedUserName !== undefined &&
    body.assignedUserName !== 'unassigned'
  ) {
    throw apiError(400, 'Unassigned tasks must use the name "unassigned".');
  }

  return {
    name,
    description,
    deadline,
    completed,
    assignedUser: assignedUser.toLowerCase()
  };
}

function fail(res, status, message) {
  return res.status(status).json({ message, data: null });
}

function handleError(res, err, resourceName) {
  if (err.apiStatus) return fail(res, err.apiStatus, err.message);
  if (err.code === 11000) return fail(res, 400, 'Email is already in use.');
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return fail(res, 400, `Invalid ${resourceName} data.`);
  }

  console.error(`Failed to update ${resourceName}:`, err.message);
  return fail(res, 500, `Unable to update ${resourceName}.`);
}

async function putUser(req, res) {
  if (!isId(req.params.id)) return fail(res, 404, 'User not found.');

  try {
    await User.init();
    await Task.init();

    const updatedUser = await User.db.transaction(async session => {
      // Check the URL resource before validating any request fields or references.
      const user = await User.findById(req.params.id).session(session);
      if (!user) throw apiError(404, 'User not found.');

      const fields = userFields(req.body);
      const duplicate = await User.exists({
        email: fields.email,
        _id: { $ne: user._id }
      }).session(session);
      if (duplicate) throw apiError(400, 'Email is already in use.');

      const tasks = await Task.find({
        _id: { $in: fields.pendingTasks }
      }).session(session);

      if (tasks.some(task => task.completed)) {
        throw apiError(400, 'Completed tasks cannot be included in pendingTasks.');
      }
      if (tasks.length !== fields.pendingTasks.length) {
        throw apiError(404, 'One or more referenced tasks do not exist.');
      }

      // Set every editable field, retaining the original _id and dateCreated.
      user.set(fields);
      await user.save({ session });
      const userId = user._id.toString();

      // Removed pending tasks become unassigned; completed tasks keep their owner.
      await Task.updateMany(
        {
          assignedUser: userId,
          completed: false,
          _id: { $nin: fields.pendingTasks }
        },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
        { session, runValidators: true }
      );

      if (fields.pendingTasks.length > 0) {
        await User.updateMany(
          { _id: { $ne: user._id }, pendingTasks: { $in: fields.pendingTasks } },
          { $pull: { pendingTasks: { $in: fields.pendingTasks } } },
          { session }
        );
        await Task.updateMany(
          { _id: { $in: fields.pendingTasks } },
          { $set: { assignedUser: userId, assignedUserName: fields.name } },
          { session, runValidators: true }
        );
      }

      // Rename all tasks that remain assigned, including completed tasks.
      await Task.updateMany(
        { assignedUser: userId },
        { $set: { assignedUserName: fields.name } },
        { session, runValidators: true }
      );

      return user.toObject();
    });

    return res.status(200).json({ message: 'User updated.', data: updatedUser });
  } catch (err) {
    return handleError(res, err, 'user');
  }
}

async function putTask(req, res) {
  if (!isId(req.params.id)) return fail(res, 404, 'Task not found.');

  try {
    await User.init();
    await Task.init();

    const updatedTask = await Task.db.transaction(async session => {
      const task = await Task.findById(req.params.id).session(session);
      if (!task) throw apiError(404, 'Task not found.');

      const fields = taskFields(req.body);
      let user = null;
      if (fields.assignedUser !== '') {
        user = await User.findById(fields.assignedUser).session(session);
        if (!user) throw apiError(404, 'Assigned user does not exist.');
        if (
          req.body.assignedUserName !== undefined &&
          req.body.assignedUserName !== user.name
        ) {
          throw apiError(400, 'Assigned user name does not match the user.');
        }
      }

      task.set({ ...fields, assignedUserName: user ? user.name : 'unassigned' });
      await task.save({ session });
      const taskId = task._id.toString();

      await User.updateMany(
        { pendingTasks: taskId },
        { $pull: { pendingTasks: taskId } },
        { session }
      );
      if (user && !fields.completed) {
        await User.updateOne(
          { _id: user._id },
          { $addToSet: { pendingTasks: taskId } },
          { session, runValidators: true }
        );
      }

      return task.toObject();
    });

    return res.status(200).json({ message: 'Task updated.', data: updatedTask });
  } catch (err) {
    return handleError(res, err, 'task');
  }
}

module.exports = { putUser, putTask };
