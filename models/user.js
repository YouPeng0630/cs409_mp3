const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required.'],
    trim: true
  },

  email: {
    type: String,
    required: [true, 'Email is required.'],
    trim: true,
    unique: true
  },

  pendingTasks: {
    type: [String],
    default: []
  },

  dateCreated: {
    type: Date,
    default: Date.now,
    immutable: true
  }
});

module.exports = mongoose.model('User', userSchema);
