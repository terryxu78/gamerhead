
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import ProjectForm from './components/ProjectForm';
import AvatarGenerator from './components/AvatarGenerator';
import Studio from './components/Studio';
import AdminDashboard from './components/AdminDashboard';
import ProjectHistory from './components/ProjectHistory';
import { GameInfo, ScriptResult, AvatarConfig, TargetAspectRatio, VeoSegment, ExportRecord, AvatarHistoryEntry, GameplayFileMeta, CurrentUserInfo } from './types';
import { generateStreamerScript } from './services/gemini';
import { getUserId } from './services/logging';
import NeonButton from './components/NeonButton';
import {
    initGoogleSignIn,
    renderGoogleButton,
    promptOneTap,
    signOut,
    getStoredToken,
    storeToken,
    GoogleUser,
    SESSION_EXPIRED_EVENT,
} from './services/auth';
import {
    fetchCurrentUser,
    loadProject,
    saveProject,
    stripGameInfo,
    stripAvatarConfig,
    deriveProjectName,
    fetchObjectAsBlobUrl,
    fetchObjectAsDataUrl,
} from './services/projects';

// Internal Component containing the full app logic
// This component is fully unmounted and remounted on reset
const GameHeads: React.FC<{
  onReset: () => void;
  currentUser: GoogleUser | null;
  onSignOut?: () => void;
  userInfo: CurrentUserInfo | null;
}> = ({ onReset, currentUser, onSignOut, userInfo }) => {
  const [activeTab, setActiveTab] = useState<'script' | 'avatar' | 'studio' | 'admin'>('script');
  // Ensure user ID exists on mount
  useEffect(() => {
      getUserId();
  }, []);

  const [form, setForm] = useState<GameInfo>({
    title: '',
    url: '',
    searchGrounding: false,
    cta: '',
    videoFile: null,
    gamingDevice: 'PC', // Default
    dialoguePacking: 'Normal', // Default
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
      model: 'gemini-3.1-flash-image'  // Vertex AI global endpoint image model
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

  // ── Project persistence ────────────────────────────────────────────────
  // Everything used to live only in React state, so a lost session or a
  // reload meant re-typing the game title / store link / CTA and
  // regenerating every clip. The working set is now mirrored server-side.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [exportRecords, setExportRecords] = useState<ExportRecord[]>([]);
  const [avatarImageGcsUri, setAvatarImageGcsUri] = useState<string | null>(null);
  const [avatarHistory, setAvatarHistory] = useState<AvatarHistoryEntry[]>([]);
  const [savedGameplayMeta, setSavedGameplayMeta] = useState<GameplayFileMeta | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  // Suppresses autosave while a project is being loaded into state.
  const restoringRef = useRef(false);
  const projectIdRef = useRef<string | null>(null);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  const handleStartOverClick = () => {
    setShowResetConfirm(true);
  };

  const confirmReset = () => {
    setShowResetConfirm(false);
    onReset();
  };

  const handleExportSaved = useCallback((record: ExportRecord) => {
    setExportRecords(prev => [record, ...prev].slice(0, 50));
  }, []);

  /** The avatar image itself, so a restored project has a streamer again. */
  const handleAvatarImage = useCallback((imageUrl: string, gcsUri?: string) => {
    setGeneratedAvatarImage(imageUrl || null);
    if (!imageUrl) setAvatarImageGcsUri(null);
    else if (gcsUri) setAvatarImageGcsUri(gcsUri);
  }, []);

  const handleAvatarGenerated = useCallback((entry: AvatarHistoryEntry) => {
    setAvatarHistory(prev => [entry, ...prev.filter(a => a.gcsUri !== entry.gcsUri)].slice(0, 24));
  }, []);

  // Strip transient fields before persisting — blob URLs are meaningless once
  // the tab is gone, but the gs:// URI behind them is not.
  const serialisableSegments = useCallback((segs: VeoSegment[]): VeoSegment[] =>
    segs.map(({ videoUrl, videoOptions, isGenerating, generatedUsingPrevUrl, ...rest }) => rest),
  []);

  const hasSomethingWorthSaving = Boolean(
    (form.title && form.title.trim()) || result || segments.length > 0
  );

  // Debounced autosave. Fires on any meaningful change to the working set.
  useEffect(() => {
    if (restoringRef.current || !hasSomethingWorthSaving) return;

    const timer = setTimeout(async () => {
      setSaveState('saving');
      try {
        const res = await saveProject({
          id: projectIdRef.current || undefined,
          name: deriveProjectName(form),
          gameInfo: stripGameInfo(form),
          avatarConfig: stripAvatarConfig(avatarConfig),
          scriptText: result?.fullText || null,
          segments: serialisableSegments(segments),
          exports: exportRecords,
          avatarImageGcsUri,
          avatarHistory,
          gameplayFileMeta: savedGameplayMeta,
        });
        if (!projectIdRef.current) setProjectId(res.id);
        setLastSavedAt(res.updatedAt);
        setSaveError(null);
        setSaveState('saved');
      } catch (e: any) {
        console.error('[App] Autosave failed:', e);
        setSaveError(e?.message || 'Unknown error');
        setSaveState('error');
      }
    }, 1500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    form.title, form.url, form.cta, form.gamingDevice, form.dialoguePacking,
    form.additionalInstructions, form.targetAspectRatio, form.layoutType,
    form.pipPlacement, form.stackedPlacement, form.searchGrounding,
    avatarConfig, result?.fullText, segments, exportRecords, hasSomethingWorthSaving,
    avatarImageGcsUri, avatarHistory, savedGameplayMeta,
  ]);

  /** Restore a saved project into the editor. */
  const handleLoadProject = useCallback(async (id: string) => {
    restoringRef.current = true;
    setIsRestoring(true);
    setError(null);
    try {
      const project = await loadProject(id);

      // The gameplay File cannot be persisted, so it always has to be re-picked.
      setForm(prev => ({
        ...prev,
        ...(project.gameInfo || {}),
        videoFile: null,
      }));
      setCachedVideo(null);
      setSavedGameplayMeta(project.gameplayFileMeta || null);

      // Avatar config, with the reference image pulled back from storage so the
      // "lock the character's look" workflow survives a restore.
      if (project.avatarConfig) {
        const cfg = { ...project.avatarConfig };
        if (cfg.referenceImageGcsUri) {
          try {
            cfg.referenceImage = await fetchObjectAsDataUrl(cfg.referenceImageGcsUri);
          } catch {
            delete cfg.referenceImage;
          }
        }
        setAvatarConfig(cfg);
      }

      // Clips come back through the same-origin proxy as blob: URLs rather than
      // signed URLs. The bucket has no CORS config, so a signed URL can be
      // played but not fetched for stitching, and a canvas draw for last-frame
      // extraction fails outright — a restored project could be watched but not
      // exported. blob: URLs behave exactly like freshly generated clips.
      const restoredSegments = await Promise.all(
        (project.segments || []).map(async (seg) => {
          if (!seg.videoGcsUri) return { ...seg, videoUrl: undefined };
          try {
            return { ...seg, videoUrl: await fetchObjectAsBlobUrl(seg.videoGcsUri) };
          } catch {
            return { ...seg, videoUrl: undefined };
          }
        })
      );

      setSegments(restoredSegments);
      if (project.scriptText) {
        setResult({
          fullText: project.scriptText,
          segments: restoredSegments,
          groundingUrls: [],
        });
        setScriptHistory([project.scriptText]);
        setHistoryIndex(0);
      } else {
        setResult(null);
        setScriptHistory([]);
        setHistoryIndex(-1);
      }

      // Put the avatar back last, and suppress the invalidation effect so it
      // does not wipe the clips we just restored.
      setAvatarHistory(project.avatarHistory || []);
      setAvatarImageGcsUri(project.avatarImageGcsUri || null);
      let avatarRestored = false;
      if (project.avatarImageGcsUri) {
        try {
          const dataUrl = await fetchObjectAsDataUrl(project.avatarImageGcsUri);
          skipAvatarInvalidationRef.current = true;
          setGeneratedAvatarImage(dataUrl);
          avatarRestored = true;
        } catch {
          skipAvatarInvalidationRef.current = true;
          setGeneratedAvatarImage(null);
        }
      } else {
        skipAvatarInvalidationRef.current = true;
        setGeneratedAvatarImage(null);
      }

      setExportRecords(project.exports || []);
      setProjectId(project.id || id);
      projectIdRef.current = project.id || id;
      setLastSavedAt(project.updatedAt || null);
      setSaveState('saved');
      setActiveTab('script');
      setShowInvalidationAlert(
        [
          avatarRestored
            ? 'Project restored, including the avatar and generated clips.'
            : 'Project restored, but this project has no saved avatar — regenerate one before opening the Studio.',
          project.gameplayFileMeta
            ? `Re-attach the same gameplay video ("${project.gameplayFileMeta.name}") to keep the script and clips. Picking a different video regenerates from scratch.`
            : 'Re-attach a gameplay video to export a Full Mix — video files cannot be saved in history.',
        ].join(' ')
      );
    } finally {
      setIsRestoring(false);
      // Let state settle before re-arming autosave, otherwise the restore
      // itself would immediately trigger a redundant save.
      setTimeout(() => { restoringRef.current = false; }, 100);
    }
  }, []);

  // Monitor avatar image changes to clear generated video clips from studio.
  // Restoring a project also changes the avatar, but there the clips are being
  // deliberately put back — so the restore path sets this flag to skip one run.
  const skipAvatarInvalidationRef = useRef(false);
  useEffect(() => {
    if (skipAvatarInvalidationRef.current) {
      skipAvatarInvalidationRef.current = false;
      return;
    }
    if (segments.length > 0) {
      setSegments(prev => prev.map(seg => ({
        ...seg,
        videoUrl: undefined,
        videoOptions: undefined,
        selectedOptionIndex: undefined,
        generatedUsingPrevUrl: undefined
      })));
    }
  }, [generatedAvatarImage]);

  /**
   * Changing project inputs invalidates the script / shot list. Each setter uses
   * an updater that returns the previous reference when there is nothing to
   * clear, so React bails out instead of re-rendering on every keystroke — the
   * old version allocated fresh arrays per character, which is what let parent
   * re-renders interrupt IME composition.
   */
  const invalidateDownstream = useCallback(() => {
    setResult(prev => (prev === null ? prev : null));
    setSegments(prev => (prev.length === 0 ? prev : []));
    setScriptHistory(prev => (prev.length === 0 ? prev : []));
    setHistoryIndex(prev => (prev === -1 ? prev : -1));
    setActiveTab(prev => (prev === 'script' ? prev : 'script'));
  }, []);

  const setFieldValue = useCallback((name: keyof GameInfo, value: any) => {
      // Compare inside the updater: comparing against the render-closure `form`
      // can drop an update when React batches fast keystrokes.
      setForm(prev => (prev[name] === value ? prev : { ...prev, [name]: value }));

      // Layout / aspect-ratio changes make an existing avatar the wrong shape.
      // These come from button clicks, never from fast typing, so reading the
      // current form here is safe.
      if ((name === 'layoutType' || name === 'targetAspectRatio') && generatedAvatarImage && form[name] !== value) {
          const newLayout = name === 'layoutType' ? value : form.layoutType;
          const newRatio = name === 'targetAspectRatio' ? value : form.targetAspectRatio;

          let requiredAvatarRatio: TargetAspectRatio = '16:9';
          if (newLayout === 'classic-pip' || newLayout === 'streamer-only') {
              requiredAvatarRatio = newRatio;
          } else if (newLayout === 'stacked') {
              requiredAvatarRatio = newRatio === '16:9' ? '9:16' : '16:9';
          }

          setShowInvalidationAlert("Layout changed. Please regenerate your avatar to match the new format. Existing shot list is preserved, but clips must be regenerated.");
          setGeneratedAvatarImage(null);
          setAvatarConfig(prevConfig => ({ ...prevConfig, aspectRatio: requiredAvatarRatio }));
      }

      invalidateDownstream();
  }, [form, generatedAvatarImage, invalidateDownstream]);

  /** Commit handler for the IME-safe text fields. */
  const handleFieldCommit = useCallback((name: string, value: string) => {
      setFieldValue(name as keyof GameInfo, value);
  }, [setFieldValue]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.size > 250 * 1024 * 1024) {
        alert("File too large. Please select a video under 250MB.");
        return;
      }

      // A restored project always has to have its gameplay video re-attached,
      // because a File cannot be serialised. Wiping the script and every
      // generated clip at that moment would make restoring pointless, so treat
      // the same file (name + size + mtime) as a re-attach rather than a change.
      const meta = { name: file.name, size: file.size, lastModified: file.lastModified };
      const isSameFile = Boolean(
        savedGameplayMeta &&
        savedGameplayMeta.name === meta.name &&
        savedGameplayMeta.size === meta.size
      );

      setForm(prev => ({ ...prev, videoFile: file }));
      setCachedVideo(null);
      setSavedGameplayMeta(meta);

      if (isSameFile) {
        setActiveTab(prev => (prev === 'script' ? prev : 'script'));
      } else {
        invalidateDownstream();
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
      const basicValid = !!(form.title && form.cta && form.videoFile);
      if (form.searchGrounding) {
          return basicValid && !!form.url;
      }
      return basicValid;
  }, [form]);

  const isStudioUnlocked = isFormValid && !!generatedAvatarImage;

  const handleGenerateScript = async () => {
    const errors = [];
    if (!form.title) errors.push("Game Title");
    if (form.searchGrounding && !form.url) errors.push("Game URL");
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

      console.log("[App] Script & Shot List generation successful.");
      
      setResult(scriptResult);
      setSegments(scriptResult.segments);
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
      
      <ProjectHistory
        open={showHistory}
        onClose={() => setShowHistory(false)}
        currentProjectId={projectId}
        onLoad={handleLoadProject}
      />

      {isRestoring && (
        <div className="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-google-blue border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-gray-300">Restoring project…</p>
            </div>
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
                    <h1 className="text-3xl font-black tracking-tight text-white flex items-baseline gap-1.5">
                        <span className="bg-clip-text text-transparent bg-gradient-to-r from-google-blue to-google-green">Gamer</span>
                        <span className="text-white">Heads</span>
                        <span className="text-[10px] text-gray-500 font-bold ml-1 align-baseline uppercase tracking-wider">v1.5</span>
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
                {currentUser && onSignOut && (
                    <div className="flex items-center gap-2">
                        {currentUser.picture && (
                            <img src={currentUser.picture} alt={currentUser.name} className="w-7 h-7 rounded-full border border-gray-600" />
                        )}
                        <span className="text-xs text-gray-400 hidden sm:block">{currentUser.email}</span>
                        <button
                            onClick={onSignOut}
                            className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded border border-gray-700 hover:bg-gray-700 transition-colors"
                        >
                            Sign out
                        </button>
                    </div>
                )}
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
             <div className="md:absolute md:right-0 md:top-1/2 md:-translate-y-1/2 z-50 mt-3 md:mt-0 flex items-center gap-2">
                <span className="text-[10px] text-gray-500 hidden lg:block min-w-[86px] text-right" aria-live="polite">
                    {saveState === 'saving' && 'Saving…'}
                    {saveState === 'saved' && lastSavedAt && `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`}
                    {saveState === 'error' && (
                        <span className="text-google-yellow" title={saveError || undefined}>Save failed</span>
                    )}
                </span>
                <button
                    type="button"
                    onClick={() => setShowHistory(true)}
                    className="cursor-pointer text-xs font-bold text-gray-400 hover:text-white flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 hover:bg-gray-700 transition-colors bg-[#2D2D2D]/80 backdrop-blur-sm shadow-sm hover:shadow-md active:scale-95 transform"
                    title="Reopen a previous project"
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    History
                </button>
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
                                onCommit={handleFieldCommit}
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
                        onImageGenerated={handleAvatarImage}
                        onAvatarGenerated={handleAvatarGenerated}
                        avatarHistory={avatarHistory}
                        currentAvatarGcsUri={avatarImageGcsUri}
                        forcedAspectRatio={forcedAvatarRatio}
                        gamingDevice={form.gamingDevice}
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
                            gamingDevice={form.gamingDevice}
                            onExportSaved={handleExportSaved}
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
             {userInfo?.isAdmin && (
                 <button
                    onClick={() => setActiveTab('admin')}
                    className="text-[10px] text-gray-800 hover:text-gray-500 transition-colors"
                 >
                     Admin
                 </button>
             )}
        </div>
      </footer>
    </div>
  );
};

// -----------------------------------------------------------------------
// Google Sign-In wrapper
// -----------------------------------------------------------------------
const LoginPage: React.FC<{ clientId: string; onSignedIn: (user: GoogleUser, token: string) => void }> = ({ clientId, onSignedIn }) => {
    const btnRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        initGoogleSignIn(clientId, async (idToken) => {
            // Verify token with backend and get user info
            try {
                const res = await fetch('/api/auth/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken }),
                });
                if (!res.ok) {
                    const { error } = await res.json().catch(() => ({ error: 'Access denied' }));
                    alert(error || 'Access denied. Your account is not authorized.');
                    return;
                }
                const user: GoogleUser = await res.json();
                storeToken(idToken);
                onSignedIn(user, idToken);
            } catch {
                alert('Sign-in failed. Please try again.');
            }
        });

        if (btnRef.current) renderGoogleButton(btnRef.current);
        promptOneTap();
    }, [clientId, onSignedIn]);

    return (
        <div className="min-h-screen bg-[#121212] flex flex-col items-center justify-center gap-8">
            <div className="flex items-center gap-3">
                <span className="text-5xl">👾</span>
                <h1 className="text-4xl font-black text-white">
                    <span className="bg-clip-text text-transparent bg-gradient-to-r from-google-blue to-google-green">Gamer</span>Heads
                </h1>
            </div>
            <p className="text-gray-400 text-sm">Sign in with your Google account to continue</p>
            <div ref={btnRef} />
        </div>
    );
};

// -----------------------------------------------------------------------
// Session expiry overlay
//
// Previously an expired credential meant `currentUser` went null and the whole
// GameHeads subtree unmounted — script, shot list and generated clips all gone.
// This overlay sits on top instead, so re-authenticating resumes exactly where
// the user was.
// -----------------------------------------------------------------------
const SessionExpiredOverlay: React.FC<{
    clientId: string | null;
    onRecovered: (user: GoogleUser) => void;
    onDismiss: () => void;
}> = ({ clientId, onRecovered, onDismiss }) => {
    const btnRef = useRef<HTMLDivElement>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!clientId) return;
        initGoogleSignIn(clientId, async (idToken) => {
            setBusy(true);
            try {
                const res = await fetch('/api/auth/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken }),
                });
                if (!res.ok) return;
                const user: GoogleUser = await res.json();
                storeToken(idToken);
                onRecovered(user);
            } finally {
                setBusy(false);
            }
        });
        if (btnRef.current) renderGoogleButton(btnRef.current);
    }, [clientId, onRecovered]);

    return (
        <div
            className="fixed inset-0 z-[200] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="session-expired-title"
        >
            <div className="bg-google-surface border border-yellow-700 rounded-2xl p-8 max-w-md text-center shadow-2xl">
                <div className="w-16 h-16 bg-yellow-900/30 rounded-full flex items-center justify-center mx-auto mb-4 border border-yellow-700">
                    <span className="text-3xl">🔒</span>
                </div>
                <h3 id="session-expired-title" className="text-xl font-bold text-white mb-2">Your session expired</h3>
                <p className="text-gray-300 text-sm mb-6">
                    Sign in again to keep going. Your project, script and generated clips are still here —
                    nothing has been lost.
                </p>

                {clientId ? (
                    <div className="flex flex-col items-center gap-4">
                        <div ref={btnRef} />
                        {busy && <span className="text-xs text-gray-400">Verifying…</span>}
                    </div>
                ) : (
                    // IAP-protected deployment: re-auth requires a full navigation,
                    // there is no in-page credential to refresh.
                    <button
                        onClick={() => window.location.reload()}
                        className="bg-google-blue hover:brightness-110 text-white px-6 py-2 rounded-full font-bold transition-colors"
                    >
                        Reload to sign in
                    </button>
                )}

                <button
                    onClick={onDismiss}
                    className="mt-5 block mx-auto text-xs text-gray-500 hover:text-gray-300"
                >
                    Continue without signing in
                </button>
            </div>
        </div>
    );
};

const App: React.FC = () => {
    const [sessionKey, setSessionKey] = useState(0);
    const [isResetting, setIsResetting] = useState(false);

    // Google Sign-In state
    const [googleClientId, setGoogleClientId] = useState<string | null>(null);
    const [currentUser, setCurrentUser] = useState<GoogleUser | null>(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [userInfo, setUserInfo] = useState<CurrentUserInfo | null>(null);
    const [sessionExpired, setSessionExpired] = useState(false);

    // Who am I / am I an admin. Works in every auth mode (GIS, Basic, IAP).
    const refreshUserInfo = useCallback(() => {
        fetchCurrentUser()
            .then(setUserInfo)
            .catch(() => setUserInfo(null));
    }, []);

    // Fetch server config (googleClientId) on mount
    useEffect(() => {
        fetch('/api/config')
            .then(r => r.json())
            .then(cfg => {
                if (cfg.googleClientId) {
                    setGoogleClientId(cfg.googleClientId);
                    // Restore session if token still present
                    const token = getStoredToken();
                    if (token) {
                        fetch('/api/auth/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ idToken: token }),
                        })
                            .then(r => r.ok ? r.json() : null)
                            .then(user => { if (user?.email) setCurrentUser(user); })
                            .catch(() => {})
                            .finally(() => setAuthLoading(false));
                    } else {
                        setAuthLoading(false);
                    }
                } else {
                    // No GIS client configured — access is governed by IAP / Basic Auth
                    setAuthLoading(false);
                }
            })
            .catch(() => setAuthLoading(false));
    }, []);

    useEffect(() => {
        if (!authLoading) refreshUserInfo();
    }, [authLoading, currentUser, refreshUserInfo]);

    // Any API call that could not recover from a rejected credential raises this.
    useEffect(() => {
        const onExpired = () => setSessionExpired(true);
        window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
        return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    }, []);

    const handleSignedIn = useCallback((user: GoogleUser) => {
        setCurrentUser(user);
        setSessionExpired(false);
    }, []);

    const handleSessionRecovered = useCallback((user: GoogleUser) => {
        setCurrentUser(user);
        setSessionExpired(false);
        refreshUserInfo();
    }, [refreshUserInfo]);

    const handleSignOut = useCallback(() => {
        signOut();
        setCurrentUser(null);
        setUserInfo(null);
        setSessionExpired(false);
    }, []);

    const handleReset = useCallback(() => {
        setIsResetting(true);
        window.scrollTo(0, 0);
        setTimeout(() => {
            setSessionKey(prev => prev + 1);
            setIsResetting(false);
        }, 50);
    }, []);

    if (authLoading) {
        return (
            <div className="min-h-screen bg-[#121212] flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-google-blue border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

    // Google auth is enabled but user is not signed in
    if (googleClientId && !currentUser) {
        return <LoginPage clientId={googleClientId} onSignedIn={handleSignedIn} />;
    }

    if (isResetting) {
        return (
            <div className="min-h-screen bg-[#121212] flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-google-blue border-t-transparent rounded-full animate-spin"></div>
            </div>
        );
    }

    return (
        <>
            <GameHeads
                key={sessionKey}
                onReset={handleReset}
                currentUser={currentUser}
                onSignOut={googleClientId ? handleSignOut : undefined}
                userInfo={userInfo}
            />
            {sessionExpired && (
                <SessionExpiredOverlay
                    clientId={googleClientId}
                    onRecovered={handleSessionRecovered}
                    onDismiss={() => setSessionExpired(false)}
                />
            )}
        </>
    );
};

export default App;
