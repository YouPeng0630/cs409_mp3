const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Task name is required.'],
    trim: true
  },

  description: {
    type: String,
    default: ''
  },

  deadline: {
    type: Date,
    required: [true, 'Deadline is required.']
  },

  completed: {
    type: Boolean,
    default: false
  },

  assignedUser: {
    type: String,
    default: ''
  },

  assignedUserName: {
    type: String,
    default: 'unassigned'
  },

  dateCreated: {
    type: Date,
    default: Date.now,
    immutable: true
  }
});

module.exports = mongoose.model('Task', taskSchema);
