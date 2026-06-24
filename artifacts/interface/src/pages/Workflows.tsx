import { useState } from 'react';
import { useWorkflows, useCreateWorkflow, useDeleteWorkflow } from '@mioagent/api-client-react';

export function Workflows() {
  const { data, isLoading } = useWorkflows();
  const createWorkflow = useCreateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();

  const [instructions, setInstructions] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!instructions) return;

    createWorkflow.mutate(
      { instructions, intervalMs: intervalMinutes * 60000 },
      {
        onSuccess: () => {
          setInstructions('');
          setIntervalMinutes(60);
        },
      }
    );
  };

  const handleDelete = (id: string) => {
    deleteWorkflow.mutate({ workflowId: id });
  };

  if (isLoading) return <div className="p-6">Loading workflows...</div>;
  const workflowsList = data?.workflows || [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Workflows</h2>

      <div className="bg-white p-6 rounded-lg shadow-sm border mb-8">
        <h3 className="text-lg font-semibold mb-4">Create New Workflow</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="instructions" className="block text-sm font-medium text-slate-700 mb-1">
              Instructions
            </label>
            <textarea
              id="instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="w-full p-2 border rounded-md"
              rows={3}
              placeholder="e.g. Check portfolio value every hour..."
              required
            />
          </div>
          <div>
            <label htmlFor="intervalMinutes" className="block text-sm font-medium text-slate-700 mb-1">
              Interval (minutes)
            </label>
            <input
              id="intervalMinutes"
              type="number"
              min="1"
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="w-full p-2 border rounded-md"
              required
            />
          </div>
          <button
            type="submit"
            disabled={createWorkflow.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {createWorkflow.isPending ? 'Creating...' : 'Create Workflow'}
          </button>
        </form>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Active Workflows</h3>
        {workflowsList.length === 0 ? (
          <p className="text-slate-600">No active workflows found.</p>
        ) : (
          workflowsList.map((wf) => (
            <div key={wf.id} className="bg-white border rounded-lg p-4 shadow-sm flex justify-between items-start">
              <div>
                <p className="font-medium mb-2">{wf.instructions}</p>
                <div className="text-sm text-slate-500 space-y-1">
                  <p>Interval: {wf.intervalMs ? wf.intervalMs / 60000 : 0} minutes</p>
                  <p>Created: {new Date(wf.createdAt).toLocaleString()}</p>
                  <p>Last Run: {wf.lastRun ? new Date(wf.lastRun).toLocaleString() : 'Never'}</p>
                </div>
              </div>
              <button
                onClick={() => handleDelete(wf.id)}
                disabled={deleteWorkflow.isPending}
                className="px-3 py-1 bg-red-100 text-red-700 rounded-md text-sm hover:bg-red-200 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
