import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';

const SettingsPanel = ({ open, onClose }) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setIsOpen = (value) => {
    if (open === undefined) {
      setInternalOpen(value);
    }
    if (!value) {
      onClose?.();
    }
  };
  const [isLoading, setIsLoading] = useState(false);
  const [settings, setSettings] = useState({
    openaiModel: '',
    openaiApiKey: '',
    elevenLabsApiKey: '',
    elevenLabsVoiceId: '',
    elevenLabsModelId: ''
  });

  // Fetch current settings when panel opens
  useEffect(() => {
    if (isOpen) {
      fetchSettings();
    }
  }, [isOpen]);

  const fetchSettings = async () => {
    try {
      const response = await fetch(`${API_URL}/settings`);
      if (response.ok) {
        const currentSettings = await response.json();
        setSettings(currentSettings);
      }
    } catch (error) {
      console.error('Error fetching settings:', error);
    }
  };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setIsLoading(true);
        try {
        // First get current settings
        const response = await fetch(`${API_URL}/settings`);
        const currentSettings = await response.json();
    
        // Merge current settings with changes, only including non-empty values
        const updatedSettings = {
            ...currentSettings,
            ...Object.fromEntries(
            Object.entries(settings).filter(([_, value]) => value !== '')
            )
        };
    
        const saveResponse = await fetch(`${API_URL}/settings`, {
            method: 'POST',
            headers: {
            'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatedSettings)
        });
    
        if (saveResponse.ok) {
            alert('Settings updated successfully! The new settings will be applied immediately.');
            setIsOpen(false);
        } else {
            const errorData = await saveResponse.json();
            throw new Error(errorData.error || 'Failed to update settings');
        }
        } catch (error) {
        console.error('Error updating settings:', error);
        alert(error.message);
        } finally {
        setIsLoading(false);
        }
    };

  return (
    <div className="fixed bottom-4 left-4 z-20">
      {open === undefined && (
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="bg-white bg-opacity-50 backdrop-blur-md p-4 rounded-lg hover:bg-opacity-70 transition-all duration-200"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      )}

      {isOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-2xl font-bold">API Settings</h2>
              <button
                onClick={() => setIsOpen(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">OpenAI Model</label>
                <input
                  type="text"
                  value={settings.openaiModel}
                  onChange={(e) => setSettings({...settings, openaiModel: e.target.value})}
                  className="mt-1 block w-full rounded-md border border-gray-300 p-2"
                  placeholder="gpt-4"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">OpenAI API Key</label>
                <input
                  type="password"
                  value={settings.openaiApiKey}
                  onChange={(e) => setSettings({...settings, openaiApiKey: e.target.value})}
                  className="mt-1 block w-full rounded-md border border-gray-300 p-2"
                  placeholder="sk-..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">ElevenLabs API Key</label>
                <input
                  type="password"
                  value={settings.elevenLabsApiKey}
                  onChange={(e) => setSettings({...settings, elevenLabsApiKey: e.target.value})}
                  className="mt-1 block w-full rounded-md border border-gray-300 p-2"
                  placeholder="elevenlabs-key..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">ElevenLabs Voice ID</label>
                <input
                  type="text"
                  value={settings.elevenLabsVoiceId}
                  onChange={(e) => setSettings({...settings, elevenLabsVoiceId: e.target.value})}
                  className="mt-1 block w-full rounded-md border border-gray-300 p-2"
                  placeholder="voice-id..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">ElevenLabs Model ID</label>
                <input
                  type="text"
                  value={settings.elevenLabsModelId}
                  onChange={(e) => setSettings({...settings, elevenLabsModelId: e.target.value})}
                  className="mt-1 block w-full rounded-md border border-gray-300 p-2"
                  placeholder="eleven_multilingual_v1"
                />
              </div>

              <div className="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="bg-gray-200 px-4 py-2 rounded-md hover:bg-gray-300 transition-colors"
                  disabled={isLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={`bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 transition-colors flex items-center ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Saving...
                    </>
                  ) : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsPanel;