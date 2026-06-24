import { useState, useEffect } from 'react';
import { useSettings, useUpdateSettings } from '@mioagent/api-client-react';

export function Settings() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();

  const [chosenModel, setChosenModel] = useState('');
  const [protocolToggles, setProtocolToggles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (settings) {
      setChosenModel(settings.chosenModel || '');
      setProtocolToggles(settings.protocolToggles || {});
    }
  }, [settings]);

  if (isLoading) return <div className="p-6">Loading settings...</div>;

  const handleSave = () => {
    updateSettings.mutate({
      chosenModel: chosenModel || undefined,
      protocolToggles,
    });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Model Selection</h3>
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Chosen Model
          </label>
          <select
            value={chosenModel}
            onChange={(e) => setChosenModel(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2"
          >
            <option value="">Default</option>
            <option value="gpt-4o">GPT-4o</option>
            <option value="gpt-4o-mini">GPT-4o-mini</option>
            <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Protocol Toggles</h3>
        <div className="space-y-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={protocolToggles['defi'] || false}
              onChange={(e) => setProtocolToggles(prev => ({ ...prev, defi: e.target.checked }))}
              className="rounded border-slate-300"
            />
            DeFi Protocols
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={protocolToggles['nft'] || false}
              onChange={(e) => setProtocolToggles(prev => ({ ...prev, nft: e.target.checked }))}
              className="rounded border-slate-300"
            />
            NFT Protocols
          </label>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={updateSettings.isPending}
        className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50"
      >
        {updateSettings.isPending ? 'Saving...' : 'Save Settings'}
      </button>

      {updateSettings.isSuccess && (
        <p className="mt-2 text-green-600 text-sm">Settings saved successfully!</p>
      )}
      {updateSettings.isError && (
        <p className="mt-2 text-red-600 text-sm">Error saving settings.</p>
      )}
    </div>
  );
}
