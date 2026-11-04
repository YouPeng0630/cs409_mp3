function parseParameter(query, name, fallback) {
  const value = query[name];
  if (value === undefined) return fallback;

  if (typeof value !== 'string') {
    throw new Error(`${name} must be supplied once.`);
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
}

function validateField(field, name) {
  const parts = field.split('.');
  if (field.startsWith('+') || field.startsWith('-') || parts.some(part =>
    part === '' || part.startsWith('$') || part.includes('\0') ||
    ['__proto__', 'prototype', 'constructor'].includes(part)
  )) {
    throw new Error(`${name} contains an invalid field name.`);
  }
}

function validateWhere(value) {
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (key.split('.').some(part =>
      ['__proto__', 'prototype', 'constructor'].includes(part) || part.includes('\0')
    )) {
      throw new Error('where contains an invalid field name.');
    }
    validateWhere(child);
  }
}

function validateSort(sort) {
  requireObject(sort, 'sort');
  for (const [field, direction] of Object.entries(sort)) {
    validateField(field, 'sort');
    if (direction !== 1 && direction !== -1) {
      throw new Error('sort field values must be 1 or -1.');
    }
  }
}

function validateProjection(projection) {
  requireObject(projection, 'select');
  let mode;
  const fields = Object.keys(projection);
  const fieldSet = new Set(fields);

  for (const field of fields) {
    validateField(field, 'select');
    const flag = projection[field];
    if (flag !== 0 && flag !== 1) {
      throw new Error('select field values must be 0 or 1.');
    }

    if (field !== '_id') {
      if (mode !== undefined && mode !== flag) {
        throw new Error('select cannot mix included and excluded fields, except _id.');
      }
      mode = flag;
    }

    const parts = field.split('.');
    for (let length = 1; length < parts.length; length += 1) {
      if (fieldSet.has(parts.slice(0, length).join('.'))) {
        throw new Error('select cannot contain overlapping field paths.');
      }
    }
  }
}

function validatePagination(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

module.exports = function makeListQuery(Model, {
  defaultLimit = 0,
  resourceName = 'resources',
  defaultSort = {}
} = {}) {
  return async function (req, res) {
    const fail = (status, message) => res.status(status).json({ message, data: null });
    let where;
    let sort;
    let projection;
    let skip;
    let limit;
    let count;

    try {
      const query = req.query;
      where = parseParameter(query, 'where', {});
      sort = parseParameter(query, 'sort', defaultSort);
      projection = parseParameter(query, 'select', {});
      skip = parseParameter(query, 'skip', 0);
      limit = parseParameter(query, 'limit', defaultLimit);
      count = parseParameter(query, 'count', false);

      requireObject(where, 'where');
      validateWhere(where);
      validateSort(sort);
      validateProjection(projection);
      validatePagination(skip, 'skip');
      validatePagination(limit, 'limit');
      if (typeof count !== 'boolean') {
        throw new Error('count must be a boolean.');
      }
    } catch (err) {
      return fail(400, err.message);
    }

    try {
      // Count matches before pagination; still validate every supplied parameter above.
      const query = count
        ? Model.countDocuments(where)
        : Model.find(where).sort(sort).select(projection).skip(skip).limit(limit).lean();

      // Mongoose can reject invalid filter operators with plain Error as well as CastError.
      try {
        query.cast(Model);
      } catch {
        return fail(400, 'Invalid where query.');
      }

      const data = await query.exec();
      return res.status(200).json({ message: 'OK', data });
    } catch (err) {
      // These server codes indicate invalid query input, rather than a database outage.
      if (
        err.name === 'CastError' ||
        err.name === 'ValidationError' ||
        (err.name === 'MongoServerError' && [2, 9, 14, 72, 51091].includes(err.code))
      ) {
        return fail(400, 'Invalid query parameters.');
      }

      console.error(`Failed to retrieve ${resourceName}:`, err.message);
      return fail(500, `Unable to retrieve ${resourceName}.`);
    }
  };
};
