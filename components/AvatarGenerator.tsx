
import React, { useState, useEffect } from 'react';
import NeonButton from './NeonButton';
import { AvatarConfig } from '../types';
import { generateStreamerAvatar } from '../services/gemini';

interface AvatarGeneratorProps {
    externalConfig?: AvatarConfig;
    setExternalConfig?: (config: AvatarConfig) => void;
    onImageGenerated?: (imageUrl: string) => void;
    forcedAspectRatio?: '16:9' | '9:16' | null;
    gamingDevice?: string;
}

const AvatarGenerator: React.FC<AvatarGeneratorProps> = ({ externalConfig, setExternalConfig, onImageGenerated, forcedAspectRatio, gamingDevice }) => {
  const [localConfig, setLocalConfig] = useState<AvatarConfig>({
    appearance: '',
    setting: '',
    aspectRatio: '16:9',
    model: 'gemini-3.1-flash-image-preview'
  });
  
  // Use external state if provided, else local
  const config = externalConfig || localConfig;
  const setConfig = setExternalConfig || setLocalConfig;

  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync forced ratio if it changes
  useEffect(() => {
    if (forcedAspectRatio) {
        setConfig(prev => ({ ...prev, aspectRatio: forcedAspectRatio }));
    }
  }, [forcedAspectRatio, setConfig]);

  const handleGenerate = async () => {
    if (!config.appearance || !config.setting) {
        setError("Please describe both appearance and setting.");
        return;
    }
    
    setIsLoading(true);
    setError(null);
    setGeneratedImage(null);

    try {
      const imageUrl = await generateStreamerAvatar({ ...config, gamingDevice });
      setGeneratedImage(imageUrl);
      if (onImageGenerated) onImageGenerated(imageUrl);
    } catch (err: any) {
      setError("Failed to generate image. Please try again.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = () => {
    if (generatedImage) {
      const link = document.createElement('a');
      link.href = generatedImage;
      link.download = 'streamer-avatar.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        setConfig(prev => ({ ...prev, referenceImage: base64String }));
      };
      reader.readAsDataURL(file);
    }
  };

  const clearReferenceImage = () => {
      setConfig(prev => ({ ...prev, referenceImage: undefined }));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 h-full min-h-full">
      {/* Left: Controls */}
      <div className="p-8 rounded-3xl bg-google-surface border border-gray-700 shadow-card h-fit">
        <h2 className="text-xl font-bold mb-6 text-white flex items-center gap-2">
          <span className="text-google-yellow">📸</span> Avatar Lab
        </h2>

        <div className="space-y-6">
          
          {/* Reference Image Upload */}
          <div>
              <label className="block text-sm font-bold text-gray-300 mb-2">Reference Image (Optional)</label>
              {!config.referenceImage ? (
                  <div className="border-2 border-dashed border-gray-600 rounded-lg p-4 text-center hover:border-google-blue hover:bg-blue-900/10 transition-all cursor-pointer relative">
                      <input 
                          type="file" 
                          accept="image/*" 
                          onChange={handleImageUpload}
                          className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                      <div className="text-gray-400 text-sm">
                          <span className="text-2xl block mb-1">🖼️</span>
                          <span className="font-bold text-google-blue">Click to upload</span> or drag and drop
                          <p className="text-xs text-gray-500 mt-1">Use a character or person as a base</p>
                      </div>
                  </div>
              ) : (
                  <div className="relative rounded-lg overflow-hidden border border-gray-600 group">
                      <img src={config.referenceImage} alt="Reference" className="w-full h-32 object-cover opacity-70 group-hover:opacity-100 transition-opacity" />
                      <button 
                          onClick={clearReferenceImage}
                          className="absolute top-2 right-2 bg-black/70 text-white p-1 rounded-full hover:bg-red-600 transition-colors"
                          title="Remove image"
                      >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                      <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                          Reference Active
                      </div>
                  </div>
              )}
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-300 mb-2">
                {config.referenceImage ? 'Avatar Description (Action/Pose)' : 'Streamer Appearance'}
            </label>
            <textarea
              value={config.appearance}
              onChange={(e) => setConfig({ ...config, appearance: e.target.value })}
              placeholder={config.referenceImage 
                  ? "Describe what they are doing, e.g. Holding a mobile phone, wearing headphones, looking excited." 
                  : "Female asian gamer in her 20s with blonde hair"}
              rows={3}
              className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-google-blue focus:border-transparent outline-none transition-all resize-none placeholder-gray-500"
            />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-300 mb-2">Background Setting</label>
            <textarea
              value={config.setting}
              onChange={(e) => setConfig({ ...config, setting: e.target.value })}
              placeholder="Dark futuristic gamer room"
              rows={3}
              className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-google-blue focus:border-transparent outline-none transition-all resize-none placeholder-gray-500"
            />
          </div>

          {/* Model Selection Removed */}

          <div>
             <div className="flex justify-between items-center mb-3">
                 <label className="block text-sm font-bold text-gray-300">Aspect Ratio</label>
                 {forcedAspectRatio && (
                     <span className="text-[10px] bg-blue-900/40 border border-blue-800 text-blue-200 px-2 py-1 rounded-full flex items-center gap-1 font-bold">
                         <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                         Locked to Gameplay ({forcedAspectRatio})
                     </span>
                 )}
             </div>
             
             <div className="flex gap-4">
                {['16:9', '9:16'].map((ratio) => (
                    <button
                        key={ratio}
                        disabled={!!forcedAspectRatio}
                        onClick={() => setConfig({ ...config, aspectRatio: ratio as any })}
                        className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                            config.aspectRatio === ratio 
                            ? 'bg-blue-900/30 border-google-blue text-google-blue' 
                            : 'bg-[#2D2D2D] border-gray-600 text-gray-400 hover:border-gray-400'
                        } ${forcedAspectRatio ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                        {ratio}
                    </button>
                ))}
             </div>
          </div>

          <div className="pt-4">
            <NeonButton 
                onClick={handleGenerate} 
                isLoading={isLoading} 
                variant="primary"
                className="w-full shadow-md"
            >
              {isLoading ? 'Generating...' : 'Generate Avatar'}
            </NeonButton>
          </div>

          {error && (
              <div className="p-4 bg-red-900/20 border border-red-900/50 text-red-300 rounded-lg text-sm text-center">
                  {error}
              </div>
          )}
        </div>
      </div>

      {/* Right: Preview */}
      <div className="h-[600px] lg:h-auto min-h-[500px] rounded-3xl bg-google-surface border border-gray-700 shadow-card flex flex-col items-center justify-center relative overflow-hidden">
          {generatedImage ? (
              <div className="w-full h-full flex flex-col p-6">
                  <div className="flex-1 min-h-0 flex items-center justify-center">
                    <img 
                      src={generatedImage} 
                      alt="Generated Streamer Avatar" 
                      className="max-h-full max-w-full object-contain rounded-xl shadow-float"
                    />
                  </div>
                  <div className="mt-6 flex justify-center shrink-0">
                    <button
                        onClick={handleDownload}
                        className="flex items-center gap-2 px-6 py-2.5 bg-[#2D2D2D] border border-gray-600 hover:bg-gray-700 text-gray-200 rounded-full transition-colors shadow-sm font-medium text-sm"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download Image
                    </button>
                  </div>
              </div>
          ) : (
              <div className="text-center p-8">
                 <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-gray-800 flex items-center justify-center border border-gray-700">
                    {isLoading ? (
                         <div className="w-12 h-12 border-4 border-google-blue border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                        <span className="text-4xl">👤</span>
                    )}
                 </div>
                 <h3 className="text-xl font-bold text-gray-200">
                    {isLoading ? 'Creating persona...' : 'No Avatar Yet'}
                 </h3>
                 <p className="text-gray-500 mt-2 max-w-xs mx-auto">
                    Fill out the details on the left to generate a unique streamer identity.
                 </p>
              </div>
          )}
      </div>
    </div>
  );
};

export default AvatarGenerator;
