const fs = require('fs');
const path = require('path');

function validateTasks(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Data must be an object');
  }

  if (!Array.isArray(data.tasks)) {
    throw new Error('Missing or invalid "tasks" array');
  }

  const requiredFields = ['id', 'title', 'status', 'instructions'];

  for (const task of data.tasks) {
    for (const field of requiredFields) {
      if (!task.hasOwnProperty(field)) {
        throw new Error(`Task ${task.id || 'unknown'} is missing required field: ${field}`);
      }
      if (typeof task[field] !== 'string' || task[field].trim() === '') {
        throw new Error(`Task ${task.id || 'unknown'} has invalid or empty field: ${field}`);
      }
    }
  }

  return true;
}

if (require.main === module) {
  try {
    const filePath = path.join(process.cwd(), 'agent_tasks.json');
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    validateTasks(data);
    console.log('agent_tasks.json is valid.');
    process.exit(0);
  } catch (error) {
    console.error('Validation failed:', error.message);
    process.exit(1);
  }
}

module.exports = { validateTasks };
