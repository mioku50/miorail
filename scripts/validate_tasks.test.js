const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateTasks } = require('./validate_tasks.js');

describe('validateTasks', () => {
  it('should pass for a valid tasks object', () => {
    const validData = {
      tasks: [
        {
          id: 'T1',
          title: 'Test',
          status: 'todo',
          instructions: 'Do something'
        }
      ]
    };
    assert.strictEqual(validateTasks(validData), true);
  });

  it('should throw if data is not an object', () => {
    assert.throws(() => validateTasks(null), /Data must be an object/);
    assert.throws(() => validateTasks('string'), /Data must be an object/);
  });

  it('should throw if tasks is missing or not an array', () => {
    assert.throws(() => validateTasks({}), /Missing or invalid "tasks" array/);
    assert.throws(() => validateTasks({ tasks: 'not an array' }), /Missing or invalid "tasks" array/);
  });

  it('should throw if a task is missing a required field', () => {
    const invalidData = {
      tasks: [
        {
          id: 'T1',
          title: 'Test',
          status: 'todo'
          // instructions missing
        }
      ]
    };
    assert.throws(() => validateTasks(invalidData), /Task T1 is missing required field: instructions/);
  });

  it('should throw if a task has an empty field', () => {
    const invalidData = {
      tasks: [
        {
          id: 'T1',
          title: '   ',
          status: 'todo',
          instructions: 'instructions'
        }
      ]
    };
    assert.throws(() => validateTasks(invalidData), /Task T1 has invalid or empty field: title/);
  });
});
