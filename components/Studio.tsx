
import React, { useState, useRef, useCallback } from 'react';
import NeonButton from './NeonButton';
import { ScriptResult, AvatarConfig, VeoSegment, LayoutType, TargetAspectRatio, PipPlacement, StackedPlacement } from '../types';
import { generateVeoClip } from '../services/gemini';
import { stitchClips, compositePipVideo } from '../utils/videoUtils';
import { logEvent } from '../services/logging';

interface StudioProps {
  scriptResult: ScriptResult | null;
  segments: VeoSegment[];
  setSegments: React.Dispatch<React.SetStateAction<VeoSegment[]>>;
  avatarImage: string | null;
  avatarConfig: AvatarConfig;
  gameplayFile: File | null;
  layoutType: LayoutType;
  targetAspectRatio: TargetAspectRatio;
  pipPlacement: PipPlacement;
  stackedPlacement: StackedPlacement;
  onGenerateScript: () => void;
  isLoading: boolean;
  statusMessage: string;
  externalError: string | null;
}

const Studio: React.FC<StudioProps> = ({ 
    scriptResult, 
    segments, 
    setSegments,
    avatarImage, 
    avatarConfig, 
    gameplayFile, 
    layoutType, 
    targetAspectRatio, 
    pipPlacement, 
    stackedPlacement, 
    onGenerateScript, 
    isLoading, 
    statusMessage, 
    externalError 
}) => {
  const [error, setError] = useState<string | null>(null);
  
  // Cancellation Control
  const abortControllerRef = useRef<AbortController | null>(null);

  // State for final stitch playback & processing
  const [showFinalPlayer, setShowFinalPlayer] = useState(false);
  const [finalBlobs, setFinalBlobs] = useState<string[]>([]);
  const [currentPlayIndex, setCurrentPlayIndex] = useState(0);
  const [isProcessingExport, setIsProcessingExport] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  
  // Audio Mix State
  const [audioVolumes, setAudioVolumes] = useState({ streamer: 1.2, gameplay: 0.4 });

  // Veo Model Selection
  const [veoModel, setVeoModel] = useState<'veo-3.1-generate-preview' | 'veo-3.1-fast-generate-preview'>('veo-3.1-generate-preview');

  const handleDownloadScript = () => {
      if (!scriptResult) return;
      const element = document.createElement("a");
      const file = new Blob([scriptResult.fullText], {type: 'text/plain'});
      element.href = URL.createObjectURL(file);
      element.download = "streamer_script.txt";
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
  };

  // --- Frame Extraction Utility ---
  const extractLastFrame = async (videoUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.src = videoUrl;
        
        video.onloadedmetadata = () => {
            video.currentTime = Math.max(0, video.duration - 0.1); // Seek to end
        };

        video.onseeked = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error("Could not get canvas context"));
                    return;
                }
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/png');
                resolve(dataUrl);
            } catch (e) {
                reject(e);
            }
        };

        video.onerror = (e) => reject(new Error("Error loading video for frame extraction"));
    });
  };

  const handleStopAll = () => {
      // Abort active generation
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
      }
  };

  const handleGenerateSegment = useCallback(async (index: number) => {
    // 1. Abort any PREVIOUSLY running generation (stops subsequent clips if they are running)
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    
    // 2. Create new controller
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let startImageBase64: string | null = null;
    
    // Determine Strategy
    // Index 0 always uses avatar.
    // Index > 0 uses user preference (defaulting to 'continuity' if not set)
    const strategy = index === 0 ? 'avatar' : (segments[index].startingFrame || 'continuity');

    if (strategy === 'avatar') {
        // Use original high-quality avatar
        startImageBase64 = avatarImage;
    } else {
        // Continuity point: Use previous frame
        const prevSegment = segments[index - 1];
        if (!prevSegment.videoUrl) {
            setError(`Cannot generate Shot ${index + 1}. Previous shot video is missing (Required for continuity).`);
            abortControllerRef.current = null;
            return;
        }
        
        try {
            startImageBase64 = await extractLastFrame(prevSegment.videoUrl);
        } catch (e) {
            console.error("Frame extraction failed", e);
            setError("Failed to extract starting frame from previous clip. Please regenerate previous clip.");
            abortControllerRef.current = null;
            return;
        }
    }

    if (!startImageBase64) {
        setError("Missing starting image source.");
        abortControllerRef.current = null;
        return;
    }

    // Update state to generating
    setSegments(prev => {
        const newSegs = [...prev];
        newSegs[index] = { ...newSegs[index], isGenerating: true };
        return newSegs;
    });
    setError(null);

    try {
        const currentSegment = segments[index]; 
        
        // generateVeoClip now performs the download internally and returns a local Blob URL
        const blobUrl = await generateVeoClip(
            currentSegment.prompt,
            currentSegment.dialogue, // Pass strict dialogue separately
            startImageBase64,
            avatarConfig.aspectRatio,
            currentSegment.duration, // Pass strictly typed duration (4/6/8)
            veoModel, // Pass selected model
            controller.signal
        );

        setSegments(prev => {
            const newSegs = [...prev];
            newSegs[index] = { 
                ...newSegs[index], 
                videoUrl: blobUrl, 
                generatedAt: Date.now(),
                isGenerating: false 
            };
            return newSegs;
        });
        
        // Clear abort ref if we finished successfully without aborting
        if (abortControllerRef.current === controller) {
             abortControllerRef.current = null;
        }
        
    } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('Aborted')) {
            console.log(`Generation for segment ${index} aborted.`);
        } else {
            console.error(err);
            setError(err.message || `Generation failed for Segment ${index + 1}.`);
        }
        
        setSegments(prev => {
            const newSegs = [...prev];
            newSegs[index] = { ...newSegs[index], isGenerating: false };
            return newSegs;
        });
        
        if (abortControllerRef.current === controller) {
             abortControllerRef.current = null;
        }
    }
  }, [segments, avatarImage, avatarConfig.aspectRatio, setSegments, veoModel]);

  const updateSegmentField = (index: number, field: 'prompt' | 'dialogue', value: string) => {
      setSegments(prev => {
          const newSegs = [...prev];
          // @ts-ignore
          newSegs[index] = { ...newSegs[index], [field]: value };
          return newSegs;
      });
  };

  const updateSegmentStrategy = (index: number, strategy: 'avatar' | 'continuity') => {
      setSegments(prev => {
          const newSegs = [...prev];
          newSegs[index] = { ...newSegs[index], startingFrame: strategy };
          return newSegs;
      });
  };

  const handleStitchAndPlay = () => {
     const blobs = segments.map(s => s.videoUrl).filter(url => url !== undefined) as string[];
     if (blobs.length !== segments.length) {
         setError("Please generate all video segments before stitching.");
         return;
     }
     setFinalBlobs(blobs);
     setCurrentPlayIndex(0);
     setShowFinalPlayer(true);
  };

  // --- Export Handlers ---
  const handleDownloadStreamerOnly = async () => {
    if (finalBlobs.length === 0) return;
    setIsProcessingExport(true);
    setExportProgress("Stitching clips together...");
    
    try {
        // Force high quality (1080p, 10Mbps)
        const stitchedBlob = await stitchClips(finalBlobs, undefined, true);
        const ext = stitchedBlob.type.includes('mp4') ? 'mp4' : 'webm';
        
        // Updated filename logic
        let filename = `Gamerheads_Streamer_${Date.now()}`;
        if (gameplayFile) {
            const originalName = gameplayFile.name.substring(0, gameplayFile.name.lastIndexOf('.')) || gameplayFile.name;
            filename = `Gamerheads_Streamer_${originalName}_${Date.now()}`;
        }

        const url = URL.createObjectURL(stitchedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // LOGGING
        logEvent('export', 'stitch-only', 'success', { aspectRatio: targetAspectRatio });

    } catch (e) {
        console.error("Export failed", e);
        setError("Failed to export streamer video.");
        logEvent('export', 'stitch-only', 'failed', { error: String(e) });
    } finally {
        setIsProcessingExport(false);
        setExportProgress(null);
    }
  };

  const handleDownloadFullGameplay = async () => {
      if (finalBlobs.length === 0) return;
      
      // If Streamer Only, redirect to simple stitch
      if (layoutType === 'streamer-only') {
          await handleDownloadStreamerOnly();
          return;
      }

      if (!gameplayFile) {
          setError("Gameplay video is missing. Cannot create composite.");
          return;
      }

      setIsProcessingExport(true);
      setExportProgress("Compositing Video (This may take a minute)...");
      
      try {
          const stitchedStreamerBlob = await stitchClips(finalBlobs);
          const stitchedStreamerUrl = URL.createObjectURL(stitchedStreamerBlob);
          
          const finalBlob = await compositePipVideo(
              gameplayFile, 
              stitchedStreamerUrl, 
              audioVolumes,
              layoutType,
              targetAspectRatio,
              pipPlacement,
              stackedPlacement
          );
          const ext = finalBlob.type.includes('mp4') ? 'mp4' : 'webm';

          const originalName = gameplayFile.name.substring(0, gameplayFile.name.lastIndexOf('.')) || gameplayFile.name;
          const url = URL.createObjectURL(finalBlob);
          const a = document.createElement('a');
          a.href = url;
          // Ensure GamerHeads_ prefix for mix
          a.download = `GamerHeads_${originalName}_Mix_${Date.now()}.${ext}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          // LOGGING
          logEvent('export', 'composite', 'success', { aspectRatio: targetAspectRatio, layout: layoutType });

      } catch (e) {
          console.error("Full export failed", e);
          setError("Failed to create final composite video.");
          logEvent('export', 'composite', 'failed', { error: String(e) });
      } finally {
          setIsProcessingExport(false);
          setExportProgress(null);
      }
  };
  
  const isAnyGenerating = segments.some(s => s.isGenerating);

  // --- Render ---

  if (!avatarImage) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-12 bg-google-surface rounded-3xl border border-gray-700 shadow-card">
        <div className="text-6xl mb-4 grayscale opacity-30">🎬</div>
        <h2 className="text-2xl font-bold text-gray-400 mb-2">Studio Locked</h2>
        <p className="text-gray-400 max-w-md">
             Complete the Project Details and generate your Avatar to proceed with this step.
        </p>
      </div>
    );
  }

  // If we don't have segments yet (and not generating), show the generation start button
  if (segments.length === 0) {
       return (
        <div className="bg-google-surface border border-gray-700 rounded-3xl p-12 flex flex-col items-center text-center shadow-card animate-fade-in">
           <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mb-6 border border-gray-700">
             {isLoading ? (
                 <div className="w-10 h-10 border-4 border-google-blue border-t-transparent rounded-full animate-spin"></div>
             ) : (
                 <span className="text-4xl">📝</span>
             )}
           </div>
           <h2 className="text-2xl font-bold text-white mb-4">
               {isLoading ? 'Generating Script & Shots...' : 'Ready for Production'}
           </h2>
           <p className="text-gray-400 max-w-lg mb-6">
             {isLoading 
                ? statusMessage 
                : "Your project details and avatar are ready. Click below to generate your script and shot list."}
           </p>
           {isLoading && (
               <p className="text-xs text-google-yellow mb-8 animate-pulse font-bold">
                   ⚠️ Keep this tab active to ensure video processing completes smoothly.
               </p>
           )}
           {!isLoading && (
               <NeonButton onClick={onGenerateScript}>
                 Generate Script & Shot List
               </NeonButton>
           )}
           {externalError && (
               <div className="mt-8 p-4 bg-red-900/20 border border-red-900/50 text-red-300 rounded-xl text-sm max-w-lg flex items-start gap-3 animate-fade-in">
                   <svg className="w-5 h-5 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                   <div className="text-left">
                       <strong className="block font-bold mb-1">Generation Failed</strong>
                       {externalError}
                   </div>
               </div>
           )}
        </div>
       );
  }

  return (
    <div className="min-h-full animate-fade-in pb-20 relative">

      {/* Header */}
      <div className="mb-8 flex justify-between items-end">
         <div>
             <h1 className="text-2xl font-bold text-white mb-2 flex items-center gap-3">
                 <span>🎬</span> Production Studio
             </h1>
             <p className="text-gray-400">Review shots, generate clips sequentially, and stitch them together.</p>
             <div className="mt-2 flex gap-2">
                 <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded border border-gray-700">Format: {targetAspectRatio}</span>
                 <span className="text-xs bg-gray-800 text-gray-400 px-2 py-1 rounded border border-gray-700">Layout: {layoutType}</span>
             </div>
         </div>
         <button 
              onClick={handleDownloadScript}
              className="text-xs text-gray-400 hover:text-white flex items-center gap-1 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg border border-gray-700 transition-colors"
          >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Download Script
          </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-900/30 border border-red-700/50 text-red-200 rounded-xl sticky top-20 z-30 shadow-md backdrop-blur-md">
          {error}
        </div>
      )}

      {/* Segments List */}
      <div className="space-y-12">
            
            {/* Toolbar Area - Split into Left (Model) and Right (Actions) */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end sticky top-20 z-20 pointer-events-none gap-4 mb-6">
                
                {/* Left: Model Selector */}
                <div className="pointer-events-auto bg-[#2D2D2D] p-1.5 rounded-xl border border-gray-700 shadow-float backdrop-blur-md">
                     <div className="flex gap-1">
                        <button 
                            onClick={() => setVeoModel('veo-3.1-generate-preview')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                veoModel === 'veo-3.1-generate-preview' 
                                ? 'bg-google-blue text-gray-900 shadow-sm' 
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            Veo 3.1 Standard
                        </button>
                        <button 
                             onClick={() => setVeoModel('veo-3.1-fast-generate-preview')}
                             className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1 ${
                                veoModel === 'veo-3.1-fast-generate-preview' 
                                ? 'bg-google-green text-gray-900 shadow-sm' 
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" /></svg>
                            Veo 3.1 Fast
                        </button>
                     </div>
                     <div className="mt-2 text-[10px] text-gray-400 max-w-[200px] leading-tight px-1 pb-1">
                        Changing this midway applies to all subsequent clip generations.
                     </div>
                </div>

                {/* Right: Actions */}
                <div className="pointer-events-auto shadow-float rounded-full bg-[#2D2D2D] p-1.5 flex gap-2 border border-gray-700 backdrop-blur-md">
                    {isAnyGenerating ? (
                         <NeonButton 
                            onClick={handleStopAll} 
                            variant="danger"
                            className="shadow-none rounded-full"
                        >
                            Stop Generating
                        </NeonButton>
                    ) : (
                        <NeonButton 
                            onClick={handleStitchAndPlay} 
                            disabled={segments.some(s => !s.videoUrl)}
                            variant={segments.every(s => s.videoUrl) ? 'primary' : 'secondary'}
                            className="shadow-none rounded-full"
                        >
                            Preview Final Video
                        </NeonButton>
                    )}
                </div>
            </div>

            <div className="bg-blue-900/20 border border-blue-800/50 p-4 rounded-xl text-sm text-blue-200 mb-6 flex items-start gap-3">
                <span className="text-xl">💡</span>
                <div>
                    <strong className="block font-bold mb-1">Pro Tip: Fine-tune your shots</strong>
                    You can edit the <strong>Dialogue</strong> and <strong>Visual Prompt</strong> for each shot below before generating to get the perfect result.
                </div>
            </div>

            <div className="space-y-6">
                {segments.map((seg, idx) => {
                    // Logic: User decides via UI. Default for index > 0 is 'continuity'.
                    // If no choice made yet, assume 'continuity' for > 0, 'avatar' for 0.
                    const strategy = idx === 0 ? 'avatar' : (seg.startingFrame || 'continuity');
                    
                    const needsPrevious = strategy === 'continuity';
                    const prevHasVideo = needsPrevious ? !!segments[idx-1].videoUrl : true;
                    
                    const canGenerate = prevHasVideo && !seg.isGenerating;
                    
                    // Continuity Check logic
                    const isStale = needsPrevious && segments[idx-1].generatedAt && seg.generatedAt && segments[idx-1].generatedAt > seg.generatedAt;
                    
                    return (
                        <div key={idx} className={`bg-google-surface border rounded-2xl overflow-hidden shadow-card transition-shadow hover:shadow-card-hover ${isStale ? 'border-orange-500/50' : 'border-gray-700'}`}>
                            
                            {isStale && (
                                <div className="bg-orange-900/30 text-orange-200 text-xs px-4 py-2 flex items-center gap-2 border-b border-orange-800/50">
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                    <strong>Continuity Warning:</strong> The previous clip was regenerated. This clip may not seamlessly connect anymore. Please regenerate this clip.
                                </div>
                            )}

                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-0">
                                {/* Left: Editor */}
                                <div className="lg:col-span-5 p-6 border-b lg:border-b-0 lg:border-r border-gray-700">
                                    <div className="flex justify-between items-center mb-4">
                                        <div className="flex items-center gap-2">
                                            <span className="text-gray-500 font-mono font-bold text-sm">SHOT {idx + 1}</span>
                                            {strategy === 'avatar' && idx > 0 && (
                                                <span className="text-[10px] bg-blue-900/30 text-blue-300 px-1.5 py-0.5 rounded border border-blue-800/50" title="Resets visual quality using original avatar">
                                                    KEYFRAME
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-xs font-bold text-gray-300 bg-gray-700 px-2 py-1 rounded">
                                            {seg.duration}s
                                        </span>
                                    </div>
                                    
                                    <div className="space-y-4">
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 block mb-1 uppercase tracking-wide">Dialogue</label>
                                            <textarea 
                                                value={seg.dialogue}
                                                onChange={(e) => updateSegmentField(idx, 'dialogue', e.target.value)}
                                                className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg p-3 text-sm text-gray-200 outline-none resize-none h-24 focus:ring-2 focus:ring-google-blue focus:border-transparent transition-all"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-gray-500 block mb-1 uppercase tracking-wide">Visual Prompt</label>
                                            <textarea 
                                                value={seg.prompt}
                                                onChange={(e) => updateSegmentField(idx, 'prompt', e.target.value)}
                                                className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg p-3 text-xs text-gray-400 outline-none resize-none h-24 focus:ring-2 focus:ring-google-blue focus:border-transparent transition-all"
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Center: Action Area */}
                                <div className="lg:col-span-2 bg-[#2D2D2D] flex flex-col items-center justify-center p-4 border-b lg:border-b-0 lg:border-r border-gray-700 gap-4">
                                    
                                    {/* Strategy Selector (Only for Index > 0) */}
                                    {idx > 0 && (
                                        <div className="w-full mb-2">
                                            <label className="text-[10px] uppercase font-bold text-gray-500 mb-2 block text-center tracking-wider">Start Frame</label>
                                            <div className="flex bg-black/30 p-1 rounded-lg border border-gray-700">
                                                <button 
                                                    onClick={() => updateSegmentStrategy(idx, 'continuity')}
                                                    className={`flex-1 text-[10px] py-1.5 rounded-md transition-colors font-medium ${strategy === 'continuity' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                                                    title="Use previous clip's last frame"
                                                >
                                                    Prev Clip
                                                </button>
                                                <button 
                                                    onClick={() => updateSegmentStrategy(idx, 'avatar')}
                                                    className={`flex-1 text-[10px] py-1.5 rounded-md transition-colors font-medium ${strategy === 'avatar' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                                                    title="Use original avatar image"
                                                >
                                                    Avatar
                                                </button>
                                            </div>
                                            {strategy === 'continuity' && (
                                                <p className="text-[9px] text-gray-500 mt-2 text-center leading-tight opacity-70">
                                                    Note: Repeated use may degrade quality over time.
                                                </p>
                                            )}
                                        </div>
                                    )}

                                    {!seg.videoUrl ? (
                                        <>
                                            <div className="w-12 h-12 rounded-full bg-google-surface border border-gray-600 shadow-sm flex items-center justify-center">
                                                <span className="text-xl text-gray-400">⬇️</span>
                                            </div>
                                            <NeonButton 
                                                onClick={() => handleGenerateSegment(idx)}
                                                disabled={!canGenerate}
                                                isLoading={seg.isGenerating}
                                                className="w-full text-xs shadow-sm"
                                                variant="secondary"
                                            >
                                                {seg.isGenerating ? 'Generating...' : 'Generate Clip'}
                                            </NeonButton>
                                            {!canGenerate && (
                                                <p className="text-[10px] text-gray-500 text-center px-2">
                                                    Waiting for Previous Clip
                                                </p>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                             <div className="w-12 h-12 rounded-full bg-green-900/30 border border-green-700 flex items-center justify-center">
                                                <span className="text-xl text-green-400">✅</span>
                                            </div>
                                            <button 
                                                onClick={() => handleGenerateSegment(idx)}
                                                className="text-xs text-gray-400 hover:text-google-blue underline"
                                                disabled={seg.isGenerating}
                                            >
                                                {seg.isGenerating ? 'Regenerating...' : 'Regenerate'}
                                            </button>
                                        </>
                                    )}
                                </div>

                                {/* Right: Preview */}
                                <div className="lg:col-span-5 bg-black relative flex items-center justify-center min-h-[250px]">
                                    {seg.videoUrl ? (
                                        <video 
                                            src={seg.videoUrl} 
                                            controls 
                                            className="w-full h-full object-contain max-h-[300px]"
                                        />
                                    ) : (
                                        <div className="text-gray-600 flex flex-col items-center">
                                            <svg className="w-12 h-12 mb-2 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zm-10-7h9v6h-9z"/></svg>
                                            <span className="text-sm">No Video Generated</span>
                                        </div>
                                    )}
                                    {seg.isGenerating && (
                                        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-10">
                                            <div className="w-10 h-10 border-4 border-google-blue border-t-transparent rounded-full animate-spin mb-3"></div>
                                            <span className="text-google-blue text-sm font-bold">Producing...</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
      </div>

      {/* Final Player Modal */}
      {showFinalPlayer && (
          <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4 backdrop-blur-sm">
              <div className="w-full max-w-5xl aspect-video bg-black rounded-xl overflow-hidden shadow-2xl relative border border-gray-700">
                  <video 
                     key={currentPlayIndex} // Force remount on index change to ensure clean play
                     src={finalBlobs[currentPlayIndex]}
                     autoPlay
                     controls
                     className="w-full h-full"
                     onEnded={() => {
                         if (currentPlayIndex < finalBlobs.length - 1) {
                             setCurrentPlayIndex(prev => prev + 1);
                         }
                     }}
                  />
                  <div className="absolute top-4 left-4 bg-black/50 text-white px-3 py-1 rounded text-xs font-mono backdrop-blur-md">
                      CLIP {currentPlayIndex + 1} / {finalBlobs.length}
                  </div>
              </div>

              {/* Controls */}
              <div className="mt-6 flex flex-col w-full max-w-5xl">
                
                {/* Audio Mix Controls */}
                {layoutType !== 'streamer-only' && (
                    <div className="w-full bg-google-surface p-6 rounded-xl border border-gray-700 mb-6 shadow-float">
                        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                            <span>🎚️</span> Export Audio Mix
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            <div>
                                <div className="flex justify-between text-xs mb-2 font-medium">
                                    <span className="text-google-blue flex items-center gap-2">
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                                        Streamer Voice
                                    </span>
                                    <span className="text-white font-bold">{Math.round(audioVolumes.streamer * 100)}%</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0" max="2" step="0.1"
                                    value={audioVolumes.streamer}
                                    onChange={(e) => setAudioVolumes(prev => ({...prev, streamer: parseFloat(e.target.value)}))}
                                    className="w-full h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-google-blue"
                                />
                            </div>
                            <div>
                                <div className="flex justify-between text-xs mb-2 font-medium">
                                    <span className="text-gray-400 flex items-center gap-2">
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
                                        Gameplay Audio
                                    </span>
                                    <span className="text-white font-bold">{Math.round(audioVolumes.gameplay * 100)}%</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0" max="1" step="0.05"
                                    value={audioVolumes.gameplay}
                                    onChange={(e) => setAudioVolumes(prev => ({...prev, gameplay: parseFloat(e.target.value)}))}
                                    className="w-full h-1.5 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-gray-500"
                                />
                            </div>
                        </div>
                    </div>
                )}

                {/* Buttons */}
                <div className="flex flex-wrap gap-4 justify-center items-center">
                    <button 
                        onClick={() => {
                            setCurrentPlayIndex(0);
                        }}
                        className="px-6 py-2.5 bg-white text-gray-900 rounded-full font-bold hover:bg-gray-200 transition-colors"
                    >
                        Replay All
                    </button>
                    <div className="w-px h-8 bg-gray-600 mx-2 hidden sm:block"></div>
                    
                    {layoutType !== 'streamer-only' && (
                        <NeonButton 
                            onClick={handleDownloadStreamerOnly} 
                            isLoading={isProcessingExport} 
                            variant="secondary"
                            className="text-xs px-4 border-gray-600 text-gray-300 hover:bg-gray-700"
                        >
                            Download Streamer Only
                        </NeonButton>
                    )}
                    
                    <NeonButton 
                        onClick={handleDownloadFullGameplay} 
                        disabled={layoutType !== 'streamer-only' && !gameplayFile} 
                        isLoading={isProcessingExport}
                        className="text-xs px-4"
                    >
                        {layoutType === 'streamer-only' ? 'Download Streamer Video' : 'Download Final Mix'}
                    </NeonButton>
                    
                    <button 
                        onClick={() => setShowFinalPlayer(false)}
                        className="ml-4 px-6 py-2 text-gray-400 hover:text-white transition-colors"
                    >
                        Close
                    </button>
                </div>
              </div>
              
              {isProcessingExport && (
                  <div className="mt-6 flex flex-col items-center gap-3">
                      <div className="text-white font-medium bg-black/50 px-6 py-2 rounded-full backdrop-blur-md border border-white/20 animate-pulse">
                          {exportProgress || "Processing video..."}
                      </div>
                      <p className="text-xs text-google-yellow font-bold animate-bounce">
                          ⚠️ IMPORTANT: Keep this tab active and visible until the download starts to prevent glitches.
                      </p>
                  </div>
              )}
          </div>
      )}
    </div>
  );
};

export default Studio;
