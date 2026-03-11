
import React, { useState } from 'react';
import NeonButton from './NeonButton';
import { GameInfo, LayoutType, TargetAspectRatio, GamingDevice } from '../types';

interface ProjectFormProps {
  form: GameInfo;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  setFieldValue: (name: keyof GameInfo, value: any) => void;
  isLoading: boolean;
  statusMessage: string;
  uploadProgress: number;
  error: string | null;
}

const ProjectForm: React.FC<ProjectFormProps> = ({
  form,
  onChange,
  onFileChange,
  setFieldValue,
  isLoading,
  statusMessage,
  uploadProgress,
  error
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const handleNext = () => {
      if (step === 1 && !form.targetAspectRatio) return;
      if (step === 2 && !form.layoutType) return;
      setStep(prev => prev + 1 as any);
  };

  const handleBack = () => {
      setStep(prev => prev - 1 as any);
  };

  // Step 1: Aspect Ratio Selection
  if (step === 1) {
      return (
          <div className="p-8 rounded-3xl bg-google-surface border border-gray-700 shadow-card animate-fade-in">
              <h1 className="text-2xl font-bold mb-2 text-white">Step 1: Choose Format</h1>
              <p className="text-gray-400 mb-8">Select the aspect ratio for your final video.</p>
              
              <div className="grid grid-cols-2 gap-6">
                  <button
                      type="button"
                      onClick={() => setFieldValue('targetAspectRatio', '16:9')}
                      className={`p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-4 ${
                          form.targetAspectRatio === '16:9' 
                          ? 'border-google-blue bg-blue-900/20 shadow-float' 
                          : 'border-gray-700 bg-[#2D2D2D] hover:border-gray-500'
                      }`}
                  >
                      <div className="w-32 h-20 border-2 border-current rounded-lg flex items-center justify-center bg-white/5">
                          <span className="font-bold text-lg">16:9</span>
                      </div>
                      <span className="font-medium text-gray-200">Landscape (YouTube In-stream)</span>
                  </button>

                  <button
                      type="button"
                      onClick={() => setFieldValue('targetAspectRatio', '9:16')}
                      className={`p-6 rounded-2xl border-2 transition-all flex flex-col items-center gap-4 ${
                          form.targetAspectRatio === '9:16' 
                          ? 'border-google-blue bg-blue-900/20 shadow-float' 
                          : 'border-gray-700 bg-[#2D2D2D] hover:border-gray-500'
                      }`}
                  >
                      <div className="w-12 h-24 border-2 border-current rounded-lg flex items-center justify-center bg-white/5">
                          <span className="font-bold text-lg">9:16</span>
                      </div>
                      <span className="font-medium text-gray-200">Portrait (YouTube Shorts)</span>
                  </button>
              </div>

              <div className="mt-8 flex justify-end">
                  <NeonButton 
                      onClick={handleNext} 
                      disabled={!form.targetAspectRatio}
                      className="px-8"
                  >
                      Next Step
                  </NeonButton>
              </div>
          </div>
      );
  }

  // Step 2: Layout Selection
  if (step === 2) {
      return (
          <div className="p-8 rounded-3xl bg-google-surface border border-gray-700 shadow-card animate-fade-in">
              <h1 className="text-2xl font-bold mb-2 text-white">Step 2: Choose Layout</h1>
              <p className="text-gray-400 mb-8">How should the streamer appear in the video?</p>
              
              <div className="space-y-4">
                  {/* Layout 1: Classic PIP */}
                  <div className={`rounded-xl border-2 transition-all overflow-hidden ${
                      form.layoutType === 'classic-pip' 
                      ? 'border-google-blue bg-blue-900/20' 
                      : 'border-gray-700 bg-[#2D2D2D]'
                  }`}>
                      <button
                          type="button"
                          onClick={() => {
                              setFieldValue('layoutType', 'classic-pip');
                              if (!form.pipPlacement) setFieldValue('pipPlacement', 'bottom-left');
                          }}
                          className="w-full p-4 flex items-center gap-4 text-left hover:bg-white/5 transition-colors"
                      >
                          <div className="w-16 h-16 bg-gray-800 rounded border border-gray-600 relative shrink-0">
                              <div className={`absolute w-5 h-5 bg-google-blue border border-white rounded-sm transition-all ${
                                  form.pipPlacement === 'top-left' ? 'top-1 left-1' :
                                  form.pipPlacement === 'top-right' ? 'top-1 right-1' :
                                  form.pipPlacement === 'bottom-right' ? 'bottom-1 right-1' :
                                  'bottom-1 left-1'
                              }`}></div>
                          </div>
                          <div>
                              <h3 className="font-bold text-white">Classic Overlay</h3>
                              <p className="text-sm text-gray-400">Streamer floats over the gameplay.</p>
                          </div>
                      </button>
                      
                      {/* Sub-options for PIP Placement */}
                      {form.layoutType === 'classic-pip' && (
                          <div className="px-4 pb-4 pt-2 border-t border-gray-700/50 flex flex-wrap gap-2 animate-fade-in">
                              <span className="text-xs font-bold text-gray-500 w-full uppercase tracking-wide mb-1">Position</span>
                              {['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((placement) => (
                                  <button
                                      key={placement}
                                      type="button"
                                      onClick={() => setFieldValue('pipPlacement', placement)}
                                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-all ${
                                          form.pipPlacement === placement
                                          ? 'bg-google-blue text-white border-google-blue'
                                          : 'bg-gray-800 text-gray-400 border-gray-600 hover:border-gray-400'
                                      }`}
                                  >
                                      {placement.replace('-', ' ').toUpperCase()}
                                  </button>
                              ))}
                          </div>
                      )}
                  </div>

                  {/* Layout 2: Stacked */}
                  <div className={`rounded-xl border-2 transition-all overflow-hidden ${
                      form.layoutType === 'stacked' 
                      ? 'border-google-blue bg-blue-900/20' 
                      : 'border-gray-700 bg-[#2D2D2D]'
                  }`}>
                      <button
                          type="button"
                          onClick={() => {
                              setFieldValue('layoutType', 'stacked');
                              // Set default stacked placement based on ratio
                              if (form.targetAspectRatio === '9:16') {
                                  setFieldValue('stackedPlacement', 'top');
                              } else {
                                  setFieldValue('stackedPlacement', 'left');
                              }
                          }}
                          className="w-full p-4 flex items-center gap-4 text-left hover:bg-white/5 transition-colors"
                      >
                          <div className="w-16 h-16 bg-gray-800 rounded border border-gray-600 relative shrink-0 flex flex-col overflow-hidden">
                              {form.targetAspectRatio === '9:16' ? (
                                  form.stackedPlacement === 'bottom' ? (
                                      <>
                                          <div className="flex-1 bg-transparent"></div>
                                          <div className="h-[35%] w-full bg-google-blue border-t border-white"></div>
                                      </>
                                  ) : (
                                      <>
                                          <div className="h-[35%] w-full bg-google-blue border-b border-white"></div>
                                          <div className="flex-1 bg-transparent"></div>
                                      </>
                                  )
                              ) : (
                                  form.stackedPlacement === 'right' ? (
                                      <div className="flex h-full w-full">
                                          <div className="flex-1 bg-transparent"></div>
                                          <div className="w-[30%] h-full bg-google-blue border-l border-white"></div>
                                      </div>
                                  ) : (
                                      <div className="flex h-full w-full">
                                          <div className="w-[30%] h-full bg-google-blue border-r border-white"></div>
                                          <div className="flex-1 bg-transparent"></div>
                                      </div>
                                  )
                              )}
                          </div>
                          <div>
                              <h3 className="font-bold text-white">Stacked</h3>
                              <p className="text-sm text-gray-400">
                                  {form.targetAspectRatio === '9:16' 
                                      ? 'Split screen vertical.' 
                                      : 'Split screen horizontal.'}
                              </p>
                          </div>
                      </button>

                      {/* Sub-options for Stacked Placement */}
                      {form.layoutType === 'stacked' && (
                          <div className="px-4 pb-4 pt-2 border-t border-gray-700/50 flex flex-wrap gap-2 animate-fade-in">
                              <span className="text-xs font-bold text-gray-500 w-full uppercase tracking-wide mb-1">Streamer Position</span>
                              {form.targetAspectRatio === '9:16' ? (
                                  <>
                                      <button
                                          type="button"
                                          onClick={() => setFieldValue('stackedPlacement', 'top')}
                                          className={`px-3 py-1.5 rounded text-xs font-medium border transition-all ${
                                              form.stackedPlacement === 'top'
                                              ? 'bg-google-blue text-white border-google-blue'
                                              : 'bg-gray-800 text-gray-400 border-gray-600 hover:border-gray-400'
                                          }`}
                                      >
                                          TOP
                                      </button>
                                      <button
                                          type="button"
                                          onClick={() => setFieldValue('stackedPlacement', 'bottom')}
                                          className={`px-3 py-1.5 rounded text-xs font-medium border transition-all ${
                                              form.stackedPlacement === 'bottom'
                                              ? 'bg-google-blue text-white border-google-blue'
                                              : 'bg-gray-800 text-gray-400 border-gray-600 hover:border-gray-400'
                                          }`}
                                      >
                                          BOTTOM
                                      </button>
                                  </>
                              ) : (
                                  <>
                                      <button
                                          type="button"
                                          onClick={() => setFieldValue('stackedPlacement', 'left')}
                                          className={`px-3 py-1.5 rounded text-xs font-medium border transition-all ${
                                              form.stackedPlacement === 'left'
                                              ? 'bg-google-blue text-white border-google-blue'
                                              : 'bg-gray-800 text-gray-400 border-gray-600 hover:border-gray-400'
                                          }`}
                                      >
                                          LEFT
                                      </button>
                                      <button
                                          type="button"
                                          onClick={() => setFieldValue('stackedPlacement', 'right')}
                                          className={`px-3 py-1.5 rounded text-xs font-medium border transition-all ${
                                              form.stackedPlacement === 'right'
                                              ? 'bg-google-blue text-white border-google-blue'
                                              : 'bg-gray-800 text-gray-400 border-gray-600 hover:border-gray-400'
                                          }`}
                                      >
                                          RIGHT
                                      </button>
                                  </>
                              )}
                          </div>
                      )}
                  </div>

                  {/* Layout 3: Streamer Only */}
                  <button
                      type="button"
                      onClick={() => setFieldValue('layoutType', 'streamer-only')}
                      className={`w-full p-4 rounded-xl border-2 transition-all flex items-center gap-4 text-left ${
                          form.layoutType === 'streamer-only' 
                          ? 'border-google-blue bg-blue-900/20' 
                          : 'border-gray-700 bg-[#2D2D2D] hover:border-gray-500'
                      }`}
                  >
                      <div className="w-16 h-16 bg-google-blue rounded border border-gray-600 relative shrink-0 flex items-center justify-center">
                          <span className="text-xl">👤</span>
                      </div>
                      <div>
                          <h3 className="font-bold text-white">Streamer Only</h3>
                          <p className="text-sm text-gray-400">Generate pure streamer reaction video without gameplay.</p>
                      </div>
                  </button>
              </div>

              <div className="mt-8 flex justify-between">
                  <button 
                      onClick={handleBack}
                      className="px-6 py-2 text-gray-400 hover:text-white transition-colors"
                  >
                      Back
                  </button>
                  <NeonButton 
                      onClick={handleNext} 
                      disabled={!form.layoutType}
                      className="px-8"
                  >
                      Next Step
                  </NeonButton>
              </div>
          </div>
      );
  }

  // Step 3: Details (Existing Form)
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="p-8 rounded-3xl bg-google-surface border border-gray-700 shadow-card">
        <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                <span className="text-google-blue">📝</span> Project Details
            </h1>
            <button 
                onClick={() => setStep(1)}
                className="text-xs text-gray-500 hover:text-google-blue underline"
                disabled={isLoading}
            >
                Change Format ({form.targetAspectRatio}, {form.layoutType})
            </button>
        </div>
        
        {error && (
            <div className="mb-6 p-4 bg-red-900/20 border border-red-900/50 text-red-300 rounded-lg text-sm">
                {error}
            </div>
        )}

        <div className="space-y-6">
          {/* Game Title */}
          <div>
            <label className="block text-sm font-bold text-gray-300 mb-2">Game Title <span className="text-google-red">*</span></label>
            <input
              type="text"
              name="title"
              value={form.title}
              onChange={onChange}
              disabled={isLoading}
              placeholder="e.g. Cyber Rush 2077"
              className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-google-blue focus:border-transparent outline-none transition-all placeholder-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {/* URL */}
          <div>
            <label className="block text-sm font-bold text-gray-300 mb-2">Game Link <span className="text-google-red">*</span></label>
            <input
              type="url"
              name="url"
              value={form.url}
              onChange={onChange}
              disabled={isLoading}
              placeholder="https://store.steampowered.com/app/..."
              className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-google-blue focus:border-transparent outline-none transition-all placeholder-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

           {/* Gaming Device */}
           <div>
            <label className="block text-sm font-bold text-gray-300 mb-2">Gaming Device <span className="text-google-red">*</span></label>
            <p className="text-xs text-gray-500 mb-2">This determines how the streamer interacts with the game in the generated video.</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(['PC', 'Console', 'Mobile (Vertical)', 'Mobile (Horizontal)'] as GamingDevice[]).map((device) => (
                    <button
                        key={device}
                        type="button"
                        onClick={() => setFieldValue('gamingDevice', device)}
                        disabled={isLoading}
                        className={`px-3 py-2.5 rounded-lg text-xs font-medium border transition-all ${
                            form.gamingDevice === device
                            ? 'bg-google-blue/20 border-google-blue text-google-blue font-bold shadow-sm'
                            : 'bg-[#2D2D2D] border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                        }`}
                    >
                        {device === 'Mobile (Vertical)' ? 'Mobile (Port.)' : 
                         device === 'Mobile (Horizontal)' ? 'Mobile (Land.)' : device}
                    </button>
                ))}
            </div>
          </div>

          {/* CTA - Freeform */}
          <div>
            <label className="block text-sm font-bold text-gray-300 mb-2">Call to Action <span className="text-google-red">*</span></label>
            <input
              type="text"
              name="cta"
              value={form.cta}
              onChange={onChange}
              disabled={isLoading}
              placeholder="e.g. Download on Steam today for 20% off!"
              className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-google-blue focus:border-transparent outline-none transition-all placeholder-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {/* Additional Instructions */}
          <div>
            <label className="block text-sm font-bold text-gray-300 mb-2">
              Specific instructions for streamer, if any. <span className="text-gray-500 font-normal">(Optional)</span>
            </label>
            <textarea
              name="additionalInstructions"
              value={form.additionalInstructions}
              onChange={onChange}
              disabled={isLoading}
              placeholder="e.g. Use an ASMR voice, be super sarcastic, mention the double-jump mechanic, and sound like a pro esports player."
              rows={3}
              className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-google-blue focus:border-transparent outline-none transition-all resize-none placeholder-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {/* Divider */}
          <div className="border-t border-gray-700 pt-4 pb-2">
            <span className="block text-sm font-bold text-gray-300 mb-2">Gameplay Source <span className="text-google-red">*</span></span>
            <div className="text-xs text-google-yellow mb-2 space-y-1">
                {form.layoutType !== 'streamer-only' && (
                    <p>Recommended: Upload a {form.targetAspectRatio} video for best results with your chosen aspect ratio</p>
                )}
            </div>
          </div>

          {/* File Upload */}
          <div className={`group relative border-2 border-dashed border-gray-600 rounded-2xl transition-colors bg-[#2D2D2D] p-8 text-center ${isLoading ? 'opacity-50 cursor-not-allowed' : 'hover:border-google-blue hover:bg-white/5'}`}>
             <input
              type="file"
              accept="video/*"
              onChange={onFileChange}
              disabled={isLoading}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 disabled:cursor-not-allowed"
            />
            <div className="space-y-3">
              <div className="mx-auto w-12 h-12 bg-gray-700 rounded-full shadow-sm border border-gray-600 flex items-center justify-center">
                {form.videoFile ? (
                  <svg className="w-6 h-6 text-google-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-gray-400 group-hover:text-google-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                )}
              </div>
              {form.videoFile ? (
                <p className="text-google-blue font-semibold">{form.videoFile.name}</p>
              ) : (
                <>
                  <p className="text-sm font-medium text-gray-300">Click to upload video</p>
                  <p className="text-xs text-google-yellow font-bold">MP4, MOV up to 250MB (Recommended &lt; 2 mins)</p>
                </>
              )}
            </div>
          </div>
          
          {isLoading && (
              <div className="mt-4">
                  <div className="flex justify-between text-xs text-gray-400 mb-1">
                      <span>{statusMessage}</span>
                      <span>{uploadProgress}%</span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                      <div 
                          className="bg-google-blue h-full transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                      ></div>
                  </div>
                  <p className="text-[10px] text-google-yellow mt-2 text-center animate-pulse">
                      ⚠️ Keep this tab active to ensure video processing completes smoothly.
                  </p>
              </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default ProjectForm;
