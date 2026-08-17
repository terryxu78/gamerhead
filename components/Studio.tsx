import React, { useState, useRef, useCallback } from 'react';
import NeonButton from './NeonButton';
import { ScriptResult, AvatarConfig, OmniSegment, OmniTake, LayoutType, TargetAspectRatio, PipPlacement, StackedPlacement } from '../types';
import { generateOmniClip, stitchClipsServer, burnSubtitlesServer } from '../services/gemini';
import { compositePipVideo } from '../utils/videoUtils';
import { logEvent } from '../services/logging';
import { buildFallbackSrt } from '../utils/subtitles';

interface StudioProps {
  scriptResult: ScriptResult | null;
  segments: OmniSegment[];
  setSegments: React.Dispatch<React.SetStateAction<OmniSegment[]>>;
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
  gamingDevice?: string;
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
    externalError,
    gamingDevice
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
  
  // Audio Mix State (Vocal FX only for Streamer)
  const [audioVolumes, setAudioVolumes] = useState({ streamer: 1.0, gameplay: 0.45 });

  // Generation Mode Selection (Single vs 2 Options)
  const [genMode, setGenMode] = useState<'single' | 'options'>('single');

  // Burn subtitles on export (built from script dialogue)
  const [burnSubtitles, setBurnSubtitles] = useState(false);

  const [isCascading, setIsCascading] = useState(false);

  const totalDuration = segments.reduce((sum, s) => sum + (s.duration || 0), 0);

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

  // --- Frame Extraction Utility for Seamless Continuity ---
  const extractLastFrame = async (videoUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.src = videoUrl;
        
        video.onloadedmetadata = () => {
            video.currentTime = Math.max(0, video.duration - 0.08); // Seek to near end
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
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                resolve(dataUrl);
            } catch (e) {
                reject(e);
            }
        };

        video.onerror = () => reject(new Error("Error loading video for seamless pose extraction"));
    });
  };

  const handleStopAll = () => {
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
      }
      setIsCascading(false);
  };

  const handleGenerateSegment = useCallback(async (index: number) => {
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (!avatarImage) {
        setError("Golden Anchor Avatar image is missing. Please create an avatar in Step 2.");
        abortControllerRef.current = null;
        return;
    }

    // Determine Start Frame Strategy:
    // Shot 0: Always uses Original Avatar (Golden Anchor)
    // Shot > 0: User preference (defaults to 'continuity' / Prev Clip)
    const strategy = index === 0 ? 'avatar' : (segments[index].startingFrame || 'continuity');
    const prevSegment = index > 0 ? segments[index - 1] : null;
    const prevUrl = prevSegment?.videoUrl || null;

    let prevPoseBase64: string | undefined = undefined;

    if (strategy === 'continuity') {
        if (!prevSegment || !prevUrl) {
            setError(`Cannot generate Shot ${index + 1}. Previous clip video is missing (Required for scene continuity).`);
            abortControllerRef.current = null;
            return;
        }

        try {
            prevPoseBase64 = await extractLastFrame(prevUrl);
        } catch (e) {
            console.error("Frame extraction failed", e);
            setError("Failed to extract pose frame from previous clip. Please regenerate the previous clip.");
            abortControllerRef.current = null;
            return;
        }
    }

    // Set segment to generating state
    setSegments(prev => {
        const newSegs = [...prev];
        newSegs[index] = {
            ...newSegs[index],
            isGenerating: true,
        };
        return newSegs;
    });
    setError(null);

    try {
        const currentSegment = segments[index];

        if (genMode === 'options') {
            const p1 = generateOmniClip(
                currentSegment.prompt,
                currentSegment.dialogue,
                currentSegment.duration,
                avatarImage,
                avatarConfig.aspectRatio,
                gamingDevice,
                prevPoseBase64,
                undefined,
                controller.signal
            );
            const p2 = generateOmniClip(
                currentSegment.prompt,
                currentSegment.dialogue,
                currentSegment.duration,
                avatarImage,
                avatarConfig.aspectRatio,
                gamingDevice,
                prevPoseBase64,
                undefined,
                controller.signal
            );

            const [res1, res2] = await Promise.all([p1, p2]);

            const newTakes: OmniTake[] = [
                {
                    id: `take-${Date.now()}-1`,
                    videoUrl: res1.videoUrl,
                    dialogue: currentSegment.dialogue,
                    prompt: currentSegment.prompt,
                    createdAt: Date.now()
                },
                {
                    id: `take-${Date.now()}-2`,
                    videoUrl: res2.videoUrl,
                    dialogue: currentSegment.dialogue,
                    prompt: currentSegment.prompt,
                    createdAt: Date.now()
                }
            ];

            setSegments(prev => {
                const newSegs = [...prev];
                const existingTakes = newSegs[index].takes || [];
                const combinedTakes = [...existingTakes, ...newTakes];
                newSegs[index] = {
                    ...newSegs[index],
                    videoUrl: res1.videoUrl,
                    takes: combinedTakes,
                    activeTakeIndex: combinedTakes.length - 2, // Selected option 1 by default
                    generatedAt: Date.now(),
                    generatedUsingPrevUrl: strategy === 'continuity' ? (prevSegment?.videoUrl || undefined) : undefined,
                    interactionId: res1.interactionId,
                    isGenerating: false
                };
                return newSegs;
            });
        } else {
            const res = await generateOmniClip(
                currentSegment.prompt,
                currentSegment.dialogue,
                currentSegment.duration,
                avatarImage,
                avatarConfig.aspectRatio,
                gamingDevice,
                prevPoseBase64,
                undefined,
                controller.signal
            );

            const newTake: OmniTake = {
                id: `take-${Date.now()}`,
                videoUrl: res.videoUrl,
                dialogue: currentSegment.dialogue,
                prompt: currentSegment.prompt,
                createdAt: Date.now()
            };

            setSegments(prev => {
                const newSegs = [...prev];
                const existingTakes = newSegs[index].takes || [];
                const combinedTakes = [...existingTakes, newTake];
                newSegs[index] = {
                    ...newSegs[index],
                    videoUrl: res.videoUrl,
                    takes: combinedTakes,
                    activeTakeIndex: combinedTakes.length - 1,
                    generatedAt: Date.now(),
                    generatedUsingPrevUrl: strategy === 'continuity' ? (prevSegment?.videoUrl || undefined) : undefined,
                    interactionId: res.interactionId,
                    isGenerating: false
                };
                return newSegs;
            });
        }

        if (abortControllerRef.current === controller) {
             abortControllerRef.current = null;
        }

    } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('Aborted')) {
            console.log(`Generation for segment ${index} aborted.`);
        } else {
            console.error(err);
            setError(err.message || `Generation failed for Shot ${index + 1}.`);
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
  }, [segments, avatarImage, avatarConfig.aspectRatio, setSegments, genMode, gamingDevice]);

  // --- Cascade Continuity (Propagate ending pose downstream) ---
  const handleCascadeContinuity = async (startIndex: number) => {
    setIsCascading(true);
    setError(null);
    try {
        for (let i = startIndex; i < segments.length; i++) {
            await handleGenerateSegment(i);
        }
    } catch (e: any) {
        console.error("Cascade failed", e);
        setError("Cascade continuity was interrupted.");
    } finally {
        setIsCascading(false);
    }
  };

  const selectTake = (segIndex: number, takeIndex: number) => {
    setSegments(prev => {
        const newSegs = [...prev];
        const seg = newSegs[segIndex];
        if (seg.takes && seg.takes[takeIndex]) {
            newSegs[segIndex] = {
                ...seg,
                activeTakeIndex: takeIndex,
                videoUrl: seg.takes[takeIndex].videoUrl,
                dialogue: seg.takes[takeIndex].dialogue,
                prompt: seg.takes[takeIndex].prompt
            };
        }
        return newSegs;
    });
  };

  const updateSegmentField = (index: number, field: 'prompt' | 'dialogue', value: string) => {
      setSegments(prev => {
          const newSegs = [...prev];
          newSegs[index] = { ...newSegs[index], [field]: value };
          return newSegs;
      });
  };

  const updateSegmentStrategy = (index: number, strategy: 'continuity' | 'avatar') => {
      setSegments(prev => {
          const newSegs = [...prev];
          newSegs[index] = { ...newSegs[index], startingFrame: strategy };
          return newSegs;
      });
  };

  const handleStitchAndPlay = () => {
     const blobs = segments.map(s => s.videoUrl).filter(url => url !== undefined) as string[];
     if (blobs.length !== segments.length) {
         setError("Please generate all video shots before previewing the complete one-take livestream.");
         return;
     }
     setFinalBlobs(blobs);
     setCurrentPlayIndex(0);
     setShowFinalPlayer(true);
  };

  // --- Export Handlers ---
  const subtitleLogMeta = () => ({ subtitles: burnSubtitles ? 'on' : 'off' });

  const handleDownloadStreamerOnly = async () => {
    if (finalBlobs.length === 0) return;
    setIsProcessingExport(true);
    setExportProgress("Stitching seamless one-take streamer video...");
    
    try {
        const subtitleSrt = burnSubtitles ? buildFallbackSrt(segments) : undefined;
        const stitchedBlob = await stitchClipsServer(
            finalBlobs,
            setExportProgress,
            subtitleSrt,
        );
        const ext = stitchedBlob.type.includes('mp4') ? 'mp4' : 'webm';

        const suffix = burnSubtitles ? '_Subtitled' : '';
        let filename = `GamerHeads_Streamer_OneTake${suffix}_${Date.now()}`;
        if (gameplayFile) {
            const originalName = gameplayFile.name.substring(0, gameplayFile.name.lastIndexOf('.')) || gameplayFile.name;
            filename = `GamerHeads_Streamer_${originalName}${suffix}_${Date.now()}`;
        }

        const url = URL.createObjectURL(stitchedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        logEvent('export', 'stitch-only', 'success', { aspectRatio: targetAspectRatio, ...subtitleLogMeta() });

    } catch (e) {
        console.error("Export failed", e);
        setError("Failed to export streamer video.");
        logEvent('export', 'stitch-only', 'failed', { error: String(e), ...subtitleLogMeta() });
    } finally {
        setIsProcessingExport(false);
        setExportProgress(null);
    }
  };

  const handleDownloadFullGameplay = async () => {
      if (finalBlobs.length === 0) return;
      
      if (layoutType === 'streamer-only') {
          await handleDownloadStreamerOnly();
          return;
      }

      if (!gameplayFile) {
          setError("Gameplay video is missing. Cannot create composite.");
          return;
      }

      setIsProcessingExport(true);
      setExportProgress("Preparing seamless streamer track & composite in parallel...");

      const wantsSubtitles = burnSubtitles;
      const stitchStreamerPromise = stitchClipsServer(finalBlobs);

      try {
          const stitchedStreamerBlob = await stitchStreamerPromise;
          const stitchedStreamerUrl = URL.createObjectURL(stitchedStreamerBlob);

          setExportProgress("Compositing seamless streamer over gameplay (keep this tab active)...");
          const compositeBlob = await compositePipVideo(
              gameplayFile,
              stitchedStreamerUrl,
              audioVolumes,
              layoutType,
              targetAspectRatio,
              pipPlacement,
              stackedPlacement,
          );
          URL.revokeObjectURL(stitchedStreamerUrl);

          let finalBlob = compositeBlob;

          if (wantsSubtitles) {
              const srt = buildFallbackSrt(segments);
              if (srt.trim()) {
                  finalBlob = await burnSubtitlesServer(compositeBlob, srt, setExportProgress);
              }
          }

          const ext = finalBlob.type.includes('mp4') ? 'mp4' : 'webm';
          const originalName = gameplayFile.name.substring(0, gameplayFile.name.lastIndexOf('.')) || gameplayFile.name;
          const suffix = wantsSubtitles ? '_Subtitled' : '';
          const url = URL.createObjectURL(finalBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `GamerHeads_${originalName}_Mix${suffix}_${Date.now()}.${ext}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          logEvent('export', 'composite', 'success', { aspectRatio: targetAspectRatio, layout: layoutType, ...subtitleLogMeta() });

      } catch (e) {
          console.error("Full export failed", e);
          setError("Failed to create final composite video.");
          logEvent('export', 'composite', 'failed', { error: String(e), ...subtitleLogMeta() });
      } finally {
          setIsProcessingExport(false);
          setExportProgress(null);
      }
  };
  
  const isAnyGenerating = segments.some(s => s.isGenerating) || isCascading;

  // --- Render ---

  if (!avatarImage) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-12 bg-google-surface rounded-3xl border border-gray-700 shadow-card">
        <div className="text-6xl mb-4 grayscale opacity-30">🎬</div>
        <h2 className="text-2xl font-bold text-gray-400 mb-2">Studio Locked</h2>
        <p className="text-gray-400 max-w-md">
             Complete the Project Details and lock your Golden Anchor Avatar to proceed with this step.
        </p>
      </div>
    );
  }

  if (segments.length === 0) {
       return (
        <div className="bg-google-surface border border-gray-700 rounded-3xl p-12 flex flex-col items-center text-center shadow-card animate-fade-in">
           <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mb-6 border border-gray-700">
             {isLoading ? (
                 <div className="w-10 h-10 border-4 border-google-blue border-t-transparent rounded-full animate-spin"></div>
             ) : (
                 <span className="text-4xl">🎬</span>
             )}
           </div>
           <h2 className="text-2xl font-bold text-white mb-4">
               {isLoading ? 'Analyzing Video with Gemini 3.6 Flash...' : 'Ready for Production'}
           </h2>
           <p className="text-gray-400 max-w-lg mb-6">
             {isLoading 
                ? statusMessage 
                : "Your Golden Anchor Avatar and gameplay footage are ready. Click below to generate your synchronized script and shot timeline."}
           </p>
           {isLoading && (
               <p className="text-xs text-google-yellow mb-8 animate-pulse font-bold">
                   ⚡ Powered by Gemini 3.6 Flash & Gemini Omni Flash. Keep this tab active.
               </p>
           )}
           {!isLoading && (
               <NeonButton onClick={onGenerateScript}>
                 Generate Script & Shot Timeline
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
      <div className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
         <div>
             <h1 className="text-2xl font-bold text-white mb-2 flex items-center gap-3">
                 <span>👾</span> Production Studio
                 <span className="text-xs bg-google-blue/20 text-google-blue px-2.5 py-1 rounded-full border border-google-blue/40 font-mono font-normal">
                     Gemini Omni Flash ⚡
                 </span>
             </h1>
             <p className="text-gray-400">Review shots, edit dialogue and actions, and generate seamless one-take livestream clips.</p>
             <div className="mt-2 flex flex-wrap gap-2 items-center">
                 <span className="text-xs bg-gray-800 text-gray-300 px-2.5 py-1 rounded border border-gray-700">Format: {targetAspectRatio}</span>
                 <span className="text-xs bg-gray-800 text-gray-300 px-2.5 py-1 rounded border border-gray-700">Layout: {layoutType}</span>
                 <span className="text-xs bg-gray-800 text-green-400 font-mono px-2.5 py-1 rounded border border-gray-700">
                     Total Timeline: {totalDuration}s
                 </span>
             </div>
             {scriptResult?.groundingUrls && scriptResult.groundingUrls.length > 0 && (
                 <div className="mt-3 flex flex-wrap gap-2 items-center">
                     <span className="text-xs text-google-blue font-bold flex items-center gap-1 shrink-0">
                         🔍 Researched Sources:
                     </span>
                     {scriptResult.groundingUrls.map((url, idx) => {
                         let display = `Source ${idx + 1}`;
                         try {
                             display = new URL(url).hostname.replace('www.', '');
                         } catch { /* ignore */ }
                         return (
                             <a
                                 key={idx}
                                 href={url}
                                 target="_blank"
                                 rel="noopener noreferrer"
                                 className="text-[10px] bg-blue-900/20 text-blue-300 hover:text-white px-2 py-0.5 rounded border border-blue-900/50 hover:bg-google-blue/30 transition-all truncate max-w-[150px]"
                                 title={url}
                             >
                                 {display}
                             </a>
                         );
                     })}
                 </div>
             )}
         </div>
         <button 
              onClick={handleDownloadScript}
              className="text-xs text-gray-400 hover:text-white flex items-center gap-1 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-lg border border-gray-700 transition-colors shrink-0"
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
            
            {/* Toolbar Area */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end sticky top-20 z-20 pointer-events-none gap-4 mb-6">
                
                {/* Left: Mode Switcher */}
                <div className="pointer-events-auto flex gap-3">
                    <div className="bg-[#2D2D2D] p-1.5 rounded-xl border border-gray-700 shadow-float backdrop-blur-md flex items-center gap-1">
                        <button
                            onClick={() => setGenMode('single')}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                genMode === 'single'
                                ? 'bg-google-blue text-gray-900 shadow-sm'
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            Single Take
                        </button>
                        <button
                             onClick={() => setGenMode('options')}
                             className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                                genMode === 'options'
                                ? 'bg-google-blue text-gray-900 shadow-sm'
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            2 Options (Parallel)
                        </button>
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
                            Preview Seamless Video
                        </NeonButton>
                    )}
                </div>
            </div>

            {/* Shots List */}
            <div className="space-y-6">
                {segments.map((seg, idx) => {
                    const strategy = idx === 0 ? 'avatar' : (seg.startingFrame || 'continuity');
                    const needsPrevious = strategy === 'continuity';
                    const prevHasVideo = needsPrevious ? !!segments[idx-1]?.videoUrl : true;
                    const canGenerate = prevHasVideo && !seg.isGenerating;
                    const isStale = needsPrevious && !!seg.videoUrl && seg.generatedUsingPrevUrl !== segments[idx-1]?.videoUrl;
                    
                    return (
                        <div key={idx} className={`bg-google-surface border rounded-2xl overflow-hidden shadow-card transition-shadow hover:shadow-card-hover ${isStale ? 'border-orange-500/50' : 'border-gray-700'}`}>
                            
                            {/* Cascade Continuity Banner */}
                            {isStale && (
                                <div className="bg-orange-900/30 text-orange-200 text-xs px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-orange-800/50">
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-orange-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                                        <span><strong>Continuity Notice:</strong> The preceding shot ending pose changed. Re-align this clip for a 100% seamless unbroken take.</span>
                                    </div>
                                    <button 
                                        onClick={() => handleCascadeContinuity(idx)}
                                        disabled={isCascading}
                                        className="bg-orange-500 hover:bg-orange-400 text-gray-950 font-bold px-3 py-1 rounded text-xs transition-colors shadow-sm"
                                    >
                                        {isCascading ? 'Re-aligning...' : '⚡ Cascade Continuity Downstream'}
                                    </button>
                                </div>
                            )}

                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-0">
                                
                                {/* Left: Editor */}
                                <div className="lg:col-span-6 p-6 border-b lg:border-b-0 lg:border-r border-gray-700 flex flex-col justify-between">
                                    <div>
                                        <div className="flex justify-between items-center mb-4">
                                            <div className="flex items-center gap-2">
                                                <span className="text-gray-400 font-mono font-bold text-sm">SHOT {idx + 1}</span>
                                                <span className="text-[10px] bg-purple-900/30 text-purple-300 px-2 py-0.5 rounded border border-purple-800/50">
                                                    {seg.startTime} - {seg.endTime}
                                                </span>
                                            </div>
                                            <span className="text-xs font-bold text-gray-300 bg-gray-700 px-2 py-1 rounded font-mono">
                                                {seg.duration}s
                                            </span>
                                        </div>
                                        
                                        <div className="space-y-4">
                                            <div>
                                                <label className="text-xs font-bold text-gray-400 block mb-1 uppercase tracking-wide flex justify-between">
                                                    <span>Streamer Dialogue & Vocal FX</span>
                                                    <span className="text-[10px] text-gray-500 font-normal">e.g. [Laughing], [Gasping], [ASMR whisper]</span>
                                                </label>
                                                <textarea 
                                                    value={seg.dialogue}
                                                    onChange={(e) => updateSegmentField(idx, 'dialogue', e.target.value)}
                                                    className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg p-3 text-sm text-gray-200 outline-none resize-none h-24 focus:ring-2 focus:ring-google-blue focus:border-transparent transition-all"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-gray-400 block mb-1 uppercase tracking-wide">
                                                    Micro-Expression & Body Action Prompt
                                                </label>
                                                <textarea 
                                                    value={seg.prompt}
                                                    onChange={(e) => updateSegmentField(idx, 'prompt', e.target.value)}
                                                    className="w-full bg-[#2D2D2D] border border-gray-600 rounded-lg p-3 text-xs text-gray-300 outline-none resize-none h-24 focus:ring-2 focus:ring-google-blue focus:border-transparent transition-all"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Center: Generate Action Area */}
                                <div className="lg:col-span-2 bg-[#2D2D2D] flex flex-col items-center justify-center p-4 border-b lg:border-b-0 lg:border-r border-gray-700 gap-3">
                                    {idx === 0 ? (
                                        <div className="text-[10px] uppercase font-bold text-gray-400 text-center tracking-wider mb-1">
                                            Golden Anchor
                                        </div>
                                    ) : (
                                        <div className="w-full mb-1">
                                            <label className="text-[10px] uppercase font-bold text-gray-400 mb-1.5 block text-center tracking-wider">
                                                Start Image
                                            </label>
                                            <div className="flex bg-black/40 p-1 rounded-lg border border-gray-700">
                                                <button 
                                                    type="button"
                                                    onClick={() => updateSegmentStrategy(idx, 'continuity')}
                                                    className={`flex-1 text-[10px] py-1.5 px-1 rounded-md transition-all font-bold ${
                                                        strategy === 'continuity' 
                                                            ? 'bg-google-blue text-gray-950 shadow-sm' 
                                                            : 'text-gray-400 hover:text-white'
                                                    }`}
                                                    title="Use previous clip ending pose for scene continuity (0% jump cuts)"
                                                >
                                                    Prev Clip
                                                </button>
                                                <button 
                                                    type="button"
                                                    onClick={() => updateSegmentStrategy(idx, 'avatar')}
                                                    className={`flex-1 text-[10px] py-1.5 px-1 rounded-md transition-all font-bold ${
                                                        strategy === 'avatar' 
                                                            ? 'bg-google-blue text-gray-950 shadow-sm' 
                                                            : 'text-gray-400 hover:text-white'
                                                    }`}
                                                    title="Use original high-quality avatar image for maximum character fidelity"
                                                >
                                                    Original Avatar
                                                </button>
                                            </div>
                                            <p className="text-[9px] text-gray-500 mt-1 text-center leading-tight">
                                                {strategy === 'continuity' ? '🎬 Scene continuity' : '✨ Max avatar fidelity'}
                                            </p>
                                        </div>
                                    )}

                                    {seg.isGenerating ? (
                                        <>
                                            <div className="w-10 h-10 border-4 border-google-blue border-t-transparent rounded-full animate-spin mb-1"></div>
                                            <span className="text-[11px] text-google-blue font-bold text-center">
                                                Omni Flash...
                                            </span>
                                            {genMode === 'options' && (
                                                <span className="text-[9px] text-gray-400">Rendering 2 takes</span>
                                            )}
                                        </>
                                    ) : !seg.videoUrl ? (
                                        <>
                                            <div className="w-10 h-10 rounded-full bg-google-surface border border-gray-600 shadow-sm flex items-center justify-center">
                                                <span className="text-lg text-gray-400">⚡</span>
                                            </div>
                                            <NeonButton
                                                onClick={() => handleGenerateSegment(idx)}
                                                disabled={!canGenerate}
                                                isLoading={seg.isGenerating}
                                                className="w-full text-xs shadow-sm"
                                                variant="primary"
                                            >
                                                Generate Clip
                                            </NeonButton>
                                            {!canGenerate && (
                                                <p className="text-[10px] text-gray-400 text-center px-2">
                                                    Waiting for Previous Shot
                                                </p>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                             <div className="w-10 h-10 rounded-full bg-green-900/30 border border-green-700 flex items-center justify-center">
                                                <span className="text-lg text-green-400">✅</span>
                                             </div>
                                             <button
                                                 onClick={() => handleGenerateSegment(idx)}
                                                 className="text-xs text-gray-400 hover:text-google-blue underline"
                                                 disabled={seg.isGenerating}
                                             >
                                                 Render New Take
                                             </button>
                                        </>
                                    )}
                                </div>

                                {/* Right: Video & Take Switcher */}
                                <div className="lg:col-span-4 bg-black relative flex flex-col justify-between min-h-[250px] p-2">
                                    <div className="flex-1 flex items-center justify-center">
                                        {seg.videoUrl ? (
                                            <video
                                                src={seg.videoUrl}
                                                controls
                                                className="w-full h-full object-contain max-h-[260px] rounded"
                                            />
                                        ) : (
                                            <div className="text-gray-600 flex flex-col items-center">
                                                <svg className="w-12 h-12 mb-2 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zm-10-7h9v6h-9z"/></svg>
                                                <span className="text-xs">No Clip Generated</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Takes Selector Bar */}
                                    {seg.takes && seg.takes.length > 1 && (
                                        <div className="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between px-2">
                                            <span className="text-[10px] text-gray-500 font-bold uppercase">Takes:</span>
                                            <div className="flex gap-1.5">
                                                {seg.takes.map((take, tIdx) => (
                                                    <button
                                                        key={take.id}
                                                        onClick={() => selectTake(idx, tIdx)}
                                                        className={`text-[10px] font-bold px-2 py-0.5 rounded transition-all ${
                                                            seg.activeTakeIndex === tIdx
                                                            ? 'bg-google-green text-gray-950 font-bold shadow-sm'
                                                            : 'bg-gray-800 text-gray-400 hover:text-white'
                                                        }`}
                                                    >
                                                        Take {tIdx + 1}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {seg.isGenerating && (
                                        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-10 rounded">
                                            <div className="w-10 h-10 border-4 border-google-blue border-t-transparent rounded-full animate-spin mb-3"></div>
                                            <span className="text-google-blue text-sm font-bold">Generating with Omni Flash...</span>
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
                     key={currentPlayIndex}
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
                  <div className="absolute top-4 left-4 bg-black/60 text-white px-3 py-1 rounded text-xs font-mono backdrop-blur-md border border-white/10">
                      SHOT {currentPlayIndex + 1} / {finalBlobs.length} (Seamless Livestream)
                  </div>
              </div>

              {/* Controls */}
              <div className="mt-6 flex flex-col w-full max-w-5xl">
                
                {/* Audio Mix Controls */}
                {layoutType !== 'streamer-only' && (
                    <div className="w-full bg-google-surface p-6 rounded-xl border border-gray-700 mb-6 shadow-float">
                        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                            <span>🎚️</span> Master Audio Mix
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            <div>
                                <div className="flex justify-between text-xs mb-2 font-medium">
                                    <span className="text-google-blue flex items-center gap-2">
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                                        Streamer Voice & Vocal FX
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

                {/* Subtitle toggle */}
                <div className="mb-4 flex flex-col items-center gap-1">
                    <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer select-none">
                        <input
                            type="checkbox"
                            checked={burnSubtitles}
                            onChange={(e) => setBurnSubtitles(e.target.checked)}
                            disabled={isProcessingExport}
                            className="w-4 h-4 accent-google-blue cursor-pointer disabled:cursor-not-allowed"
                        />
                        <span>Add subtitles (from script dialogue)</span>
                    </label>
                    <p className="text-xs text-gray-500">
                        Burns subtitles built from the script dialogue onto the final video — adaptive-size gaming-variety style.
                    </p>
                </div>

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
                          ⚠️ IMPORTANT: Keep this tab active and visible until download begins.
                      </p>
                  </div>
              )}
          </div>
      )}
    </div>
  );
};

export default Studio;
