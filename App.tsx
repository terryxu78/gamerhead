
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import ProjectForm from './components/ProjectForm';
import AvatarGenerator from './components/AvatarGenerator';
import Studio from './components/Studio';
import AdminDashboard from './components/AdminDashboard';
import { GameInfo, ScriptResult, AvatarConfig, TargetAspectRatio, VeoSegment } from './types';
import { generateStreamerScript, analyzeScriptForVeo, getEffectiveApiKey } from './services/gemini';
import { getUserId } from './services/logging';
import NeonButton from './components/NeonButton';

// Internal Component containing the full app logic
// This component is fully unmounted and remounted on reset
const GameHeads: React.FC<{ onReset: () => void }> = ({ onReset }) => {
  const [activeTab, setActiveTab] = useState<'script' | 'avatar' | 'studio' | 'admin'>('script');
  const [keyError, setKeyError] = useState<string | null>(null);

  // Check key on mount (Just for alerting, not for editing)
  useEffect(() => {
      const key = getEffectiveApiKey();
      if (!key) {
          setKeyError("CRITICAL: GEMINI_API_KEY is missing in this deployment. The app will not function correctly.");
      }
      // Ensure user ID exists
      getUserId();
  }, []);

  const [form, setForm] = useState<GameInfo>({
    title: '',
    url: '',
    cta: '',
    videoFile: null,
    gamingDevice: 'PC', // Default
    additionalInstructions: '',
    targetAspectRatio: '16:9', // Default
    layoutType: 'classic-pip', // Default
    pipPlacement: 'bottom-left',
    stackedPlacement: 'left' // Default for 16:9
  });
  
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>({
      appearance: '',
      setting: '',
      aspectRatio: '16:9',
      model: 'gemini-2.5-flash-image'
  });
  
  const [generatedAvatarImage, setGeneratedAvatarImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("Analyzing...");
  const [uploadProgress, setUploadProgress] = useState(0);
  
  const [cachedVideo, setCachedVideo] = useState<{file: File, data: string, mimeType: string} | null>(null);
  
  const [result, setResult] = useState<ScriptResult | null>(null);
  const [segments, setSegments] = useState<VeoSegment[]>([]);
  const [scriptHistory, setScriptHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [showInvalidationAlert, setShowInvalidationAlert] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const handleStartOverClick = () => {
    setShowResetConfirm(true);
  };

  const confirmReset = () => {
    setShowResetConfirm(false);
    onReset();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
    
    if (result) {
        setResult(null);
        setSegments([]);
        setScriptHistory([]);
        setHistoryIndex(-1);
    }
  };

  const setFieldValue = (name: keyof GameInfo, value: any) => {
      setForm(prev => {
          if (prev[name] === value) return prev;
          const newState = { ...prev, [name]: value };
          
          if ((name === 'layoutType' || name === 'targetAspectRatio') && generatedAvatarImage) {
              const newLayout = name === 'layoutType' ? value : prev.layoutType;
              const newRatio = name === 'targetAspectRatio' ? value : prev.targetAspectRatio;
              
              let requiredAvatarRatio: TargetAspectRatio = '16:9';
              if (newLayout === 'classic-pip' || newLayout === 'streamer-only') {
                  requiredAvatarRatio = newRatio;
              } else if (newLayout === 'stacked') {
                  requiredAvatarRatio = newRatio === '16:9' ? '9:16' : '16:9';
              }
              
              setShowInvalidationAlert("Layout changed. Please regenerate your avatar to match the new format. Existing shot list is preserved, but clips must be regenerated.");
              setGeneratedAvatarImage(null); 
              setAvatarConfig(prevConfig => ({ ...prevConfig, aspectRatio: requiredAvatarRatio }));
              
              setSegments(prevSegments => prevSegments.map(s => ({
                  ...s,
                  videoUrl: undefined,
                  isGenerating: false,
                  generatedAt: undefined
              })));
          }
          return newState;
      });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 250 * 1024 * 1024) {
        alert("File too large. Please select a video under 250MB.");
        return;
      }
      setForm(prev => ({ ...prev, videoFile: file }));
      setCachedVideo(null);

      if (result) {
          setResult(null);
          setSegments([]);
          setScriptHistory([]);
          setHistoryIndex(-1);
      }
    }
  };

  const forcedAvatarRatio = useMemo<TargetAspectRatio | null>(() => {
      if (form.layoutType === 'stacked') {
          if (form.targetAspectRatio === '9:16') return '16:9';
          if (form.targetAspectRatio === '16:9') return '9:16';
      } else if (form.layoutType === 'classic-pip' || form.layoutType === 'streamer-only') {
          return form.targetAspectRatio;
      }
      return null;
  }, [form.layoutType, form.targetAspectRatio]);

  const isFormValid = useMemo(() => {
      return !!(form.title && form.url && form.cta && form.videoFile);
  }, [form]);

  const isStudioUnlocked = isFormValid && !!generatedAvatarImage;

  const handleGenerateScript = async () => {
    const errors = [];
    if (!form.title) errors.push("Game Title");
    if (!form.url) errors.push("Game Link");
    if (!form.cta) errors.push("Call to Action");
    if (!form.videoFile) errors.push("Video File");

    if (errors.length > 0) {
        setError(`Please provide the following required fields: ${errors.join(', ')}`);
        return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);
    setSegments([]);
    setScriptHistory([]);
    setHistoryIndex(-1);
    setStatusMessage("Initializing...");
    setUploadProgress(0);

    console.log("[App] Starting script generation...");

    try {
      const apiKey = getEffectiveApiKey();
      if (!apiKey) {
          throw new Error("API Key is missing. Please check deployment configuration.");
      }

      let cachedData = undefined;
      if (form.videoFile && cachedVideo && form.videoFile === cachedVideo.file) {
          cachedData = { data: cachedVideo.data, mimeType: cachedVideo.mimeType };
      }

      const scriptResult = await generateStreamerScript(
        form, 
        (msg, progress) => {
          setStatusMessage(msg);
          setUploadProgress(progress);
        },
        cachedData
      );
      
      if (scriptResult.inlineData && form.videoFile && !cachedData) {
        setCachedVideo({
          file: form.videoFile,
          data: scriptResult.inlineData.data,
          mimeType: scriptResult.inlineData.mimeType
        });
      }

      setStatusMessage("Creating Shot List...");
      setUploadProgress(95);
      const shotList = await analyzeScriptForVeo(scriptResult.fullText);
      
      console.log("[App] Script & Shot List generation successful.");
      
      setResult(scriptResult);
      setSegments(shotList);
      setScriptHistory([scriptResult.fullText]);
      setHistoryIndex(0);
      
    } catch (err: any) {
      console.error("[App] Script generation failed:", err);
      setError(err.message || "Something went wrong generating the script.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-google-background text-google-text font-sans flex flex-col">
      
      {/* Critical Env Error Banner */}
      {keyError && (
          <div className="bg-red-900/80 text-white text-center p-3 font-bold border-b border-red-700">
              {keyError}
          </div>
      )}

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
            <div className="bg-google-surface border border-gray-600 rounded-2xl p-6 max-w-sm w-full shadow-2xl transform scale-100 transition-all">
                <h3 className="text-xl font-bold text-white mb-2">Start fresh?</h3>
                <p className="text-gray-400 mb-6 text-sm leading-relaxed">
                    This will delete all current progress, including your script and avatar. This action cannot be undone.
                </p>
                <div className="flex gap-3 justify-end">
                    <button 
                        onClick={() => setShowResetConfirm(false)}
                        className="px-4 py-2 text-gray-300 hover:text-white font-medium text-sm transition-colors rounded-lg hover:bg-white/5"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={confirmReset}
                        className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold text-sm shadow-md transition-colors"
                    >
                        Start Over
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Invalidation Alert Modal */}
      {showInvalidationAlert && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
              <div className="bg-google-surface border border-yellow-600 rounded-2xl p-8 max-w-md text-center shadow-2xl">
                  <div className="w-16 h-16 bg-yellow-900/30 rounded-full flex items-center justify-center mx-auto mb-4 border border-yellow-700">
                      <span className="text-3xl">⚠️</span>
                  </div>
                  <h3 className="text-xl font-bold text-white mb-2">Attention Needed</h3>
                  <p className="text-gray-300 mb-6">
                      {showInvalidationAlert}
                  </p>
                  <button 
                      onClick={() => setShowInvalidationAlert(null)}
                      className="bg-yellow-600 hover:bg-yellow-500 text-white px-6 py-2 rounded-full font-bold transition-colors"
                  >
                      Understood
                  </button>
              </div>
          </div>
      )}

      {/* Attribution Header */}
      <div className="bg-[#0e0e0e] border-b border-gray-800 py-1 px-4 text-center">
        <p className="text-[10px] text-gray-500 font-medium tracking-wide">
          Created by <a href="mailto:raynerseah@google.com" className="hover:text-google-blue transition-colors">raynerseah@google.com</a>
        </p>
      </div>

      {/* Navbar */}
      <nav className="bg-google-surface border-b border-gray-700 sticky top-0 z-40 shrink-0 shadow-sm relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-4">
            <div className="flex items-center w-full md:w-auto justify-center md:justify-start gap-6">
                <div className="flex flex-col items-center md:items-start">
                    <div className="flex items-center gap-3 group cursor-default">
                    <div className="relative">
                        <span className="text-4xl transition-transform group-hover:scale-110 duration-300 block filter drop-shadow-sm">👾</span>
                        <span className="absolute -bottom-1 -right-1 text-lg">🎧</span>
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-white">
                        <span className="bg-clip-text text-transparent bg-gradient-to-r from-google-blue to-google-green">Gamer</span>
                        <span className="text-white">Heads</span>
                    </h1>
                    </div>
                    <p className="text-xs sm:text-sm text-gray-400 font-medium mt-1 text-center md:text-left hidden sm:block">
                    Make gameplay assets more engaging with AI Gaming Streamers!
                    </p>
                </div>
            </div>
            
            <div className="flex items-center gap-4">
                <span className="text-[10px] font-bold text-google-green bg-green-900/20 px-3 py-1.5 rounded-full border border-green-800 flex items-center gap-1">
                    ⚡ Powered by Nano Banana & Veo 3.1
                </span>
            </div>
          </div>
          
          <div className="relative w-full flex flex-col md:flex-row items-center justify-center gap-4">
            {activeTab !== 'admin' && (
             <div className="flex bg-google-gray p-1 rounded-full border border-gray-600 overflow-x-auto relative z-0">
                <button
                    onClick={() => setActiveTab('script')}
                    className={`px-5 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap ${
                        activeTab === 'script' 
                        ? 'bg-gray-600 text-white shadow-sm' 
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                >
                    Project Details
                </button>
                <button
                    onClick={() => setActiveTab('avatar')}
                    className={`px-5 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap ${
                        activeTab === 'avatar' 
                        ? 'bg-gray-600 text-white shadow-sm' 
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                >
                    Avatar
                </button>
                <button
                    onClick={() => setActiveTab('studio')}
                    className={`px-5 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap flex items-center gap-2 ${
                        activeTab === 'studio' 
                        ? 'bg-gray-600 text-white shadow-sm' 
                        : 'text-gray-400 hover:text-gray-200'
                    } ${!isStudioUnlocked ? 'opacity-50' : ''}`}
                >
                    Studio
                    {!isStudioUnlocked && (
                        <span className="ml-1 text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded font-bold border border-gray-600">LOCKED</span>
                    )}
                </button>
             </div>
            )}
            
            {activeTab === 'admin' && (
                 <div className="flex bg-google-gray p-1 rounded-full border border-gray-600 relative z-0">
                    <button
                        className="px-5 py-1.5 rounded-full text-sm font-medium bg-gray-600 text-white shadow-sm whitespace-nowrap"
                    >
                        Administrator View
                    </button>
                 </div>
            )}

            {activeTab !== 'admin' && (
             <div className="md:absolute md:right-0 md:top-1/2 md:-translate-y-1/2 z-50 mt-3 md:mt-0 flex gap-2">
                <button 
                    type="button"
                    onClick={handleStartOverClick}
                    className="cursor-pointer text-xs font-bold text-gray-400 hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors bg-[#2D2D2D]/80 backdrop-blur-sm shadow-sm hover:shadow-md active:scale-95 transform"
                    title="Clear all fields and start fresh"
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Start Over
                </button>
             </div>
            )}

            {activeTab === 'admin' && (
             <div className="md:absolute md:right-0 md:top-1/2 md:-translate-y-1/2 z-50 mt-3 md:mt-0 flex gap-2">
                <button 
                    type="button"
                    onClick={() => setActiveTab('script')}
                    className="cursor-pointer text-xs font-bold text-google-blue hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors"
                >
                    Back to App
                </button>
             </div>
            )}
          </div>

        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full">
        
        {activeTab === 'admin' ? (
            <AdminDashboard />
        ) : (
            <>
                <div className={`${activeTab === 'script' ? 'block' : 'hidden'}`}>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 animate-fade-in">
                        <div className="lg:col-span-2 max-w-4xl mx-auto w-full">
                            <ProjectForm
                                form={form}
                                isLoading={isLoading}
                                statusMessage={statusMessage}
                                uploadProgress={uploadProgress}
                                error={error}
                                onChange={handleInputChange}
                                onFileChange={handleFileChange}
                                setFieldValue={setFieldValue}
                            />
                        </div>
                    </div>
                </div>

                <div className={`${activeTab === 'avatar' ? 'block' : 'hidden'} animate-fade-in min-h-[calc(100vh-9rem)]`}>
                <AvatarGenerator 
                        externalConfig={avatarConfig}
                        setExternalConfig={setAvatarConfig}
                        onImageGenerated={setGeneratedAvatarImage}
                        forcedAspectRatio={forcedAvatarRatio}
                />
                </div>

                <div className={`${activeTab === 'studio' ? 'block' : 'hidden'} animate-fade-in min-h-[calc(100vh-9rem)]`}>
                    {isStudioUnlocked ? (
                        <Studio 
                            scriptResult={result} 
                            segments={segments}
                            setSegments={setSegments}
                            avatarImage={generatedAvatarImage}
                            avatarConfig={avatarConfig}
                            gameplayFile={form.videoFile} // Pass Original High-Quality File for Final Mix
                            layoutType={form.layoutType}
                            targetAspectRatio={form.targetAspectRatio}
                            pipPlacement={form.pipPlacement}
                            stackedPlacement={form.stackedPlacement}
                            onGenerateScript={handleGenerateScript}
                            isLoading={isLoading}
                            statusMessage={statusMessage}
                            externalError={error}
                        />
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-center p-12 bg-google-surface rounded-3xl border border-gray-700 shadow-card">
                            <div className="text-6xl mb-4 grayscale opacity-30">🎬</div>
                            <h2 className="text-2xl font-bold text-gray-400 mb-2">Production Studio Locked</h2>
                            <p className="text-gray-500 max-w-md">
                            Complete the Project Details and generate your Avatar to proceed with this step.
                            </p>
                        </div>
                    )}
                </div>
            </>
        )}

      </main>

      <footer className="bg-[#0e0e0e] border-t border-gray-800 py-6 px-4 text-center relative">
        <div className="max-w-5xl mx-auto text-[10px] text-gray-600 leading-relaxed">
          <p>
            Copyright Google LLC. Supported by Google LLC and/or its affiliate(s). This solution, including any related sample code or data, is made available on an “as is,” “as available,” and “with all faults” basis, solely for illustrative purposes, and without warranty or representation of any kind. This solution is experimental, unsupported and provided solely for your convenience. Your use of it is subject to your agreements with Google, as applicable, and may constitute a beta feature as defined under those agreements. To the extent that you make any data available to Google in connection with your use of the solution, you represent and warrant that you have all necessary and appropriate rights, consents and permissions to permit Google to use and process that data. By using any portion of this solution, you acknowledge, assume and accept all risks, known and unknown, associated with its usage and any processing of data by Google, including with respect to your deployment of any portion of this solution in your systems, or usage in connection with your business, if at all. In connection with this solution, you will not provide to Google any personally identifiable information, personal information or personal data.
          </p>
        </div>
        <div className="absolute right-4 bottom-4">
             <button 
                onClick={() => setActiveTab('admin')}
                className="text-[10px] text-gray-800 hover:text-gray-500 transition-colors"
             >
                 Admin
             </button>
        </div>
      </footer>
    </div>
  );
};

const App: React.FC = () => {
    const [sessionKey, setSessionKey] = useState(0);
    const [isResetting, setIsResetting] = useState(false);

    const handleReset = useCallback(() => {
        setIsResetting(true);
        window.scrollTo(0,0);
        setTimeout(() => {
            setSessionKey(prev => prev + 1);
            setIsResetting(false);
        }, 50);
    }, []);

    if (isResetting) {
        return (
            <div className="min-h-screen bg-[#121212] flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-google-blue border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

    return <GameHeads key={sessionKey} onReset={handleReset} />;
};

export default App;
