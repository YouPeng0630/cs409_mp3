function parseProjection(value) {
  if (typeof value !== 'string') {
    throw new Error('Select must be supplied once as a JSON object.');
  }

  let projection;
  try {
    projection = JSON.parse(value);
  } catch {
    throw new Error('Select must contain valid JSON.');
  }

  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    throw new Error('Select must be a JSON object.');
  }

  let mode;
  const fields = Object.keys(projection);
  const fieldSet = new Set(fields);

  for (const field of fields) {
    const parts = field.split('.');
    if (field.startsWith('+') || field.startsWith('-') || parts.some(part =>
      part === '' || part.startsWith('$') || part.includes('\0') ||
      ['__proto__', 'prototype', 'constructor'].includes(part)
    )) {
      throw new Error('Select contains an invalid field name.');
    }

    const flag = projection[field];
    if (flag !== 0 && flag !== 1) {
      throw new Error('Select field values must be 0 or 1.');
    }

    // MongoDB permits _id to differ from the projection's inclusion/exclusion mode.
    if (field !== '_id') {
      if (mode !== undefined && mode !== flag) {
        throw new Error('Select cannot mix included and excluded fields, except _id.');
      }
      mode = flag;
    }

    // A parent path and one of its children cannot both appear in a projection.
    for (let length = 1; length < parts.length; length += 1) {
      if (fieldSet.has(parts.slice(0, length).join('.'))) {
        throw new Error('Select cannot contain overlapping field paths.');
      }
    }
  }

  return projection;
}

module.exports = function makeGetById(Model, resourceName) {
  return async function (req, res) {
    const fail = (status, message) => res.status(status).json({ message, data: null });
    const id = req.params.id;

    if (typeof id !== 'string' || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return fail(404, `${resourceName} not found.`);
    }

    let projection;
    if (req.query.select !== undefined) {
      try {
        projection = parseProjection(req.query.select);
      } catch (err) {
        return fail(400, err.message);
      }
    }

    try {
      // All other query parameters are intentionally ignored on single resources.
      const document = await Model.findById(id).select(projection).lean().exec();

      if (document === null) {
        return fail(404, `${resourceName} not found.`);
      }

      return res.status(200).json({ message: 'OK', data: document });
    } catch (err) {
      console.error(`Failed to retrieve ${resourceName.toLowerCase()}:`, err.message);
      return fail(500, `Unable to retrieve ${resourceName.toLowerCase()}.`);
    }
  };
};
