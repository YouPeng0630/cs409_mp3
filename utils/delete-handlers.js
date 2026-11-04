const User = require('../models/user');
const Task = require('../models/task');

function isId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function notFound(resourceName) {
  const error = new Error(`${resourceName} not found.`);
  error.apiStatus = 404;
  return error;
}

function fail(res, status, message) {
  return res.status(status).json({ message, data: null });
}

function handleError(res, err, resourceName) {
  if (err.apiStatus === 404) return fail(res, 404, err.message);

  console.error(`Failed to delete ${resourceName}:`, err.message);
  return fail(res, 500, `Unable to delete ${resourceName}.`);
}

async function deleteUser(req, res) {
  if (!isId(req.params.id)) return fail(res, 404, 'User not found.');

  try {
    await User.init();
    await Task.init();

    await User.db.transaction(async session => {
      const user = await User.findById(req.params.id).session(session);
      if (!user) throw notFound('User');

      // Completed tasks are absent from pendingTasks, so query by assignedUser.
      await Task.updateMany(
        { assignedUser: user._id.toString() },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
        { session, runValidators: true }
      );
      await User.deleteOne({ _id: user._id }, { session });

    });

    return res.status(204).end();
  } catch (err) {
    return handleError(res, err, 'user');
  }
}

async function deleteTask(req, res) {
  if (!isId(req.params.id)) return fail(res, 404, 'Task not found.');

  try {
    await User.init();
    await Task.init();

    await Task.db.transaction(async session => {
      const task = await Task.findById(req.params.id).session(session);
      if (!task) throw notFound('Task');

      const taskId = task._id.toString();
      await User.updateMany(
        { pendingTasks: taskId },
        { $pull: { pendingTasks: taskId } },
        { session }
      );
      await Task.deleteOne({ _id: task._id }, { session });

    });

    return res.status(204).end();
  } catch (err) {
    return handleError(res, err, 'task');
  }
}

module.exports = { deleteUser, deleteTask };
