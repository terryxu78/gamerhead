
import { LayoutType, TargetAspectRatio, PipPlacement, StackedPlacement } from '../types';

/**
 * Utility functions for client-side video processing using Canvas and MediaRecorder.
 * Note: Real-time encoding in browser is resource intensive.
 */

// Helper to create an off-screen container for videos
const getHiddenContainer = () => {
    let container = document.getElementById('video-processing-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'video-processing-container';
        container.style.position = 'fixed';
        container.style.top = '-9999px';
        container.style.left = '-9999px';
        container.style.width = '1px';
        container.style.height = '1px';
        container.style.overflow = 'hidden';
        container.style.opacity = '0';
        container.style.pointerEvents = 'none';
        container.style.zIndex = '-1';
        document.body.appendChild(container);
    }
    return container;
};

// Helper to load a video element and attach it to the DOM
const loadVideo = (src: string): Promise<HTMLVideoElement> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = src;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.playsInline = true; // Critical for iOS/Mobile
    video.muted = true; // Start muted to allow autoplay
    
    // Attach to DOM to ensure frame decoding happens
    const container = getHiddenContainer();
    container.appendChild(video);

    // Timeout safety
    const timeout = setTimeout(() => {
        // If it has dimensions, it's probably fine
        if (video.videoWidth > 0) {
            resolve(video);
        } else {
            console.warn("Video load timeout, checking readyState", video.readyState);
            if (video.readyState >= 1) resolve(video);
            else reject(new Error(`Video load timed out for source: ${src.substring(0, 50)}...`));
        }
    }, 10000); // Increased to 10s for large files

    video.oncanplaythrough = () => {
      clearTimeout(timeout);
      resolve(video);
    };
    
    // Fallback if canplaythrough doesn't fire quickly but metadata is ready
    video.onloadedmetadata = () => {
        if (video.duration && video.videoWidth) {
             // Wait a tick to see if canplaythrough follows, else resolve
             setTimeout(() => {
                 clearTimeout(timeout);
                 resolve(video);
             }, 500);
        }
    };

    video.onerror = (e) => {
        clearTimeout(timeout);
        if (video.parentNode) video.parentNode.removeChild(video);
        reject(e);
    };
  });
};

const cleanupVideo = (video: HTMLVideoElement) => {
    video.pause();
    video.src = "";
    video.load();
    if (video.parentNode) {
        video.parentNode.removeChild(video);
    }
};

/**
 * Compresses a video file by resizing and reducing bitrate.
 * 
 * Strategy:
 * - < 30s: 720p, 2.5 Mbps Video, 128 kbps Audio (High Quality Analysis)
 * - > 30s: 540p, 1.5 Mbps Video, 128 kbps Audio (Space Saving)
 */
export const compressVideo = async (file: File): Promise<Blob> => {
    const src = URL.createObjectURL(file);
    const video = await loadVideo(src);
    const duration = video.duration || 0;
    
    // Adaptive Settings
    let maxDimension = 720;
    let videoBitrate = 2500000; // 2.5 Mbps default for short clips

    if (duration > 30) {
        // For longer videos, drop resolution to 540p (960x540) and bitrate to 1.5 Mbps
        // to stay within the 20MB limit while maintaining sharpness
        maxDimension = 540;
        videoBitrate = 1500000;
    }

    let width = video.videoWidth;
    let height = video.videoHeight;
    
    if (width > height) {
        if (width > maxDimension) {
            height *= maxDimension / width;
            width = maxDimension;
        }
    } else {
        if (height > maxDimension) {
            width *= maxDimension / height;
            height = maxDimension;
        }
    }
    
    // Ensure even dimensions
    width = Math.floor(width / 2) * 2;
    height = Math.floor(height / 2) * 2;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });

    // Audio setup
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const source = audioCtx.createMediaElementSource(video);
    source.connect(dest);

    const canvasStream = canvas.captureStream(24); // 24 FPS is sufficient for AI analysis
    const finalStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
    ]);

    // Codec Selection - Prefer H264 for compatibility, fallback to VP9
    let mimeType = 'video/webm;codecs=vp9';
    if (MediaRecorder.isTypeSupported('video/mp4')) {
        mimeType = 'video/mp4';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
        mimeType = 'video/webm;codecs=h264';
    }

    const mediaRecorder = new MediaRecorder(finalStream, { 
        mimeType,
        videoBitsPerSecond: videoBitrate,
        audioBitsPerSecond: 128000 // Explicitly set audio to 128kbps for clear sound analysis
    });

    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };

    return new Promise(async (resolve, reject) => {
        mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: mimeType });
            audioCtx.close();
            cleanupVideo(video);
            URL.revokeObjectURL(src);
            resolve(blob);
        };
        
        mediaRecorder.onerror = (e) => {
            audioCtx.close();
            cleanupVideo(video);
            URL.revokeObjectURL(src);
            reject(new Error("Compression failed: " + (e as any).error?.message));
        };

        // Playback logic
        video.currentTime = 0;
        video.muted = false; // Unmute for capture
        video.volume = 1.0;
        
        video.onended = () => {
            mediaRecorder.stop();
        };

        mediaRecorder.start();

        try {
            await video.play();
            
            // Draw Loop
            const draw = () => {
                if (video.paused || video.ended) return;
                if (ctx) {
                    ctx.drawImage(video, 0, 0, width, height);
                }
                requestAnimationFrame(draw);
            };
            draw();
            
        } catch (e) {
            mediaRecorder.stop();
            reject(new Error("Compression playback failed: Autoplay blocked"));
        }
    });
};

/**
 * Stitches multiple video URLs into a single continuous video Blob.
 */
export const stitchClips = async (clipUrls: string[], onProgress?: (percent: number) => void, highQuality: boolean = false): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }); // desynchronized for lower latency
  
  // Audio Context
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  
  // Load first video to get dimensions
  const firstVideo = await loadVideo(clipUrls[0]);
  
  // Ensure even dimensions for codec compatibility
  const width = firstVideo.videoWidth % 2 === 0 ? firstVideo.videoWidth : firstVideo.videoWidth - 1;
  const height = firstVideo.videoHeight % 2 === 0 ? firstVideo.videoHeight : firstVideo.videoHeight - 1;
  
  cleanupVideo(firstVideo); // Clean up the probe video

  canvas.width = width;
  canvas.height = height;

  const canvasStream = canvas.captureStream(30); // 30 FPS
  
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  let mimeType = 'video/webm;codecs=vp9';
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = 'video/mp4';
  } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
    mimeType = 'video/webm;codecs=h264';
  }

  const mediaRecorder = new MediaRecorder(combinedStream, { 
      mimeType,
      videoBitsPerSecond: highQuality ? 10000000 : 8000000 // 10 Mbps vs 8 Mbps
  });
  
  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise(async (resolve, reject) => {
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      audioCtx.close();
      resolve(blob);
    };

    mediaRecorder.start();
    mediaRecorder.pause(); // Start paused to avoid recording loading gaps

    // Play videos sequentially
    for (let i = 0; i < clipUrls.length; i++) {
      try {
        const video = await loadVideo(clipUrls[i]);
        
        // Setup Audio
        const source = audioCtx.createMediaElementSource(video);
        source.connect(dest);
        
        await new Promise<void>(async (resolveClip, rejectClip) => {
            let animationFrameId: number;
            
            video.onended = () => {
                mediaRecorder.pause(); // Pause recording between clips
                cancelAnimationFrame(animationFrameId);
                // Disconnect quietly
                try { source.disconnect(); } catch(e) {}
                cleanupVideo(video);
                resolveClip();
            };

            video.onerror = (e) => {
                cleanupVideo(video);
                rejectClip(new Error(`Error playing clip ${i}`));
            };

            // Unmute for capture
            video.muted = false;
            video.volume = 1.0;

            try {
                // Seek to start to ensure first frame is ready
                video.currentTime = 0;
                await video.play();
                mediaRecorder.resume(); // Resume recording only when playing
            } catch (e) {
                console.warn(`Autoplay failed for clip ${i}, falling back to muted`, e);
                video.muted = true;
                await video.play();
                mediaRecorder.resume();
            }

            const draw = () => {
                if (video.paused || video.ended) return;
                if (ctx && video.readyState >= 2) {
                    ctx.drawImage(video, 0, 0, width, height);
                }
                animationFrameId = requestAnimationFrame(draw);
            };
            draw();
        });

        if (onProgress) onProgress(((i + 1) / clipUrls.length) * 100);
      } catch (err) {
          console.error(`Failed to process clip ${i}`, err);
          // Continue to next clip instead of failing entire export? 
          // For now, let's reject to inform user.
          mediaRecorder.stop();
          audioCtx.close();
          reject(err);
          return; 
      }
    }

    mediaRecorder.stop();
  });
};

/**
 * Composites the Streamer Video (Overlay) onto the Gameplay Video (Background).
 */
export const compositePipVideo = async (
  gameplayFile: File,
  streamerBlobUrl: string,
  volumes: { gameplay: number; streamer: number },
  layout: LayoutType,
  targetRatio: TargetAspectRatio,
  pipPlacement: PipPlacement,
  stackedPlacement: StackedPlacement,
  onProgress?: (msg: string) => void
): Promise<Blob> => {
  const gameplayUrl = URL.createObjectURL(gameplayFile);
  
  // Load videos attached to DOM
  const bgVideo = await loadVideo(gameplayUrl);
  const overlayVideo = await loadVideo(streamerBlobUrl);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error("Canvas context failed");

  // Determine Canvas Dimensions based on Target Ratio
  // We'll use 1080p as a base reference
  let width, height;
  if (targetRatio === '16:9') {
      width = 1920;
      height = 1080;
  } else {
      width = 1080;
      height = 1920;
  }

  canvas.width = width;
  canvas.height = height;

  // --- Layout Calculations ---
  
  // 1. Gameplay (Background) Scaling - "Cover" mode
  const bgRatio = bgVideo.videoWidth / bgVideo.videoHeight;
  const canvasRatio = width / height;
  
  let bgDrawWidth, bgDrawHeight, bgOffsetX, bgOffsetY;

  if (bgRatio > canvasRatio) {
      // Video is wider than canvas -> Crop sides
      bgDrawHeight = height;
      bgDrawWidth = height * bgRatio;
      bgOffsetX = (width - bgDrawWidth) / 2;
      bgOffsetY = 0;
  } else {
      // Video is taller than canvas -> Crop top/bottom
      bgDrawWidth = width;
      bgDrawHeight = width / bgRatio;
      bgOffsetX = 0;
      bgOffsetY = (height - bgDrawHeight) / 2;
  }

  // 2. Streamer (Overlay) Positioning
  let overlayX = 0, overlayY = 0, overlayWidth = 0, overlayHeight = 0;
  
  if (layout === 'classic-pip') {
      // 10% Area (Reduced to 0.1 multiplier)
      const totalArea = width * height;
      const targetArea = totalArea * 0.1;
      const overlayAspectRatio = overlayVideo.videoWidth / overlayVideo.videoHeight;
      
      overlayWidth = Math.sqrt(targetArea * overlayAspectRatio);
      overlayHeight = overlayWidth / overlayAspectRatio;

      const padding = width * 0.02;
      
      // Calculate Position based on Placement
      switch (pipPlacement) {
          case 'top-left':
              overlayX = padding;
              overlayY = padding;
              break;
          case 'top-right':
              overlayX = width - overlayWidth - padding;
              overlayY = padding;
              break;
          case 'bottom-left':
              overlayX = padding;
              overlayY = height - overlayHeight - padding;
              break;
          case 'bottom-right':
              overlayX = width - overlayWidth - padding;
              overlayY = height - overlayHeight - padding;
              break;
          default: // Default to bottom-left
              overlayX = padding;
              overlayY = height - overlayHeight - padding;
      }

  } 
  else if (layout === 'stacked') {
      if (targetRatio === '9:16') {
          // Vertical Stack
          overlayX = 0;
          overlayWidth = width;
          const splitPoint = height * 0.35;
          overlayHeight = splitPoint;
          
          let gameAreaY = 0;
          let gameAreaHeight = 0;

          if (stackedPlacement === 'top') {
              // Streamer Top
              overlayY = 0;
              gameAreaY = splitPoint;
              gameAreaHeight = height - splitPoint;
          } else {
              // Streamer Bottom
              overlayY = height - splitPoint;
              gameAreaY = 0;
              gameAreaHeight = height - splitPoint;
          }
          
          // Re-calculate gameplay to fill the remaining area
          const gameAreaRatio = width / gameAreaHeight;
          if (bgRatio > gameAreaRatio) {
              bgDrawHeight = gameAreaHeight;
              bgDrawWidth = gameAreaHeight * bgRatio;
              bgOffsetX = (width - bgDrawWidth) / 2;
              bgOffsetY = gameAreaY;
          } else {
              bgDrawWidth = width;
              bgDrawHeight = width / bgRatio;
              bgOffsetX = 0;
              bgOffsetY = gameAreaY + (gameAreaHeight - bgDrawHeight) / 2;
          }
      } else {
          // Horizontal Stack (16:9)
          const splitPoint = width * 0.30;
          overlayWidth = splitPoint;
          overlayHeight = height;
          overlayY = 0;
          
          let gameAreaX = 0;
          let gameAreaWidth = 0;

          if (stackedPlacement === 'left') {
              // Streamer Left
              overlayX = 0;
              gameAreaX = splitPoint;
              gameAreaWidth = width - splitPoint;
          } else {
              // Streamer Right
              overlayX = width - splitPoint;
              gameAreaX = 0;
              gameAreaWidth = width - splitPoint;
          }
          
          // Re-calculate gameplay to fill the remaining area
          const gameAreaRatio = gameAreaWidth / height;
          if (bgRatio > gameAreaRatio) {
               bgDrawHeight = height;
               bgDrawWidth = height * bgRatio;
               bgOffsetX = gameAreaX + (gameAreaWidth - bgDrawWidth) / 2;
               bgOffsetY = 0;
          } else {
               bgDrawWidth = gameAreaWidth;
               bgDrawHeight = gameAreaWidth / bgRatio;
               bgOffsetX = gameAreaX;
               bgOffsetY = (height - bgDrawHeight) / 2;
          }
      }
  }

  // Setup Audio
  const audioCtx = new AudioContext();
  
  // CRITICAL: Ensure AudioContext is running. 
  // It might be suspended if too much time passed since user click (in stitchClips).
  if (audioCtx.state === 'suspended') {
      try {
          await audioCtx.resume();
      } catch (e) {
          console.warn("Failed to resume AudioContext", e);
      }
  }

  const dest = audioCtx.createMediaStreamDestination();
  
  const bgSource = audioCtx.createMediaElementSource(bgVideo);
  const overlaySource = audioCtx.createMediaElementSource(overlayVideo);
  
  const bgGain = audioCtx.createGain();
  const overlayGain = audioCtx.createGain();

  bgGain.gain.value = volumes.gameplay; 
  overlayGain.gain.value = volumes.streamer;

  bgSource.connect(bgGain);
  bgGain.connect(dest);

  overlaySource.connect(overlayGain);
  overlayGain.connect(dest);
  
  const canvasStream = canvas.captureStream(30);
  
  const finalStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  let mimeType = 'video/webm;codecs=vp9';
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = 'video/mp4';
  } else if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
    mimeType = 'video/webm;codecs=h264';
  }

  const mediaRecorder = new MediaRecorder(finalStream, { 
      mimeType,
      videoBitsPerSecond: 10000000 // 10 Mbps for high quality
  });
  
  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise(async (resolve, reject) => {
    let animationFrameId: number;
    let isRecording = false;

    mediaRecorder.onstop = () => {
      isRecording = false;
      cancelAnimationFrame(animationFrameId);
      
      const blob = new Blob(chunks, { type: mimeType });
      
      // Cleanup
      audioCtx.close();
      cleanupVideo(bgVideo);
      cleanupVideo(overlayVideo);
      URL.revokeObjectURL(gameplayUrl);
      
      resolve(blob);
    };

    mediaRecorder.onerror = (e) => {
        isRecording = false;
        cancelAnimationFrame(animationFrameId);
        cleanupVideo(bgVideo);
        cleanupVideo(overlayVideo);
        reject(new Error("MediaRecorder Error: " + (e as any).error?.message));
    };

    // Prepare playback
    bgVideo.muted = false;
    bgVideo.volume = 1.0;
    overlayVideo.muted = false;
    overlayVideo.volume = 1.0;
    
    // Do NOT loop the overlay video (streamer)
    overlayVideo.loop = false;

    // Stop when background video ends
    bgVideo.onended = () => {
        if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
    };

    // Error handling during playback
    bgVideo.onerror = (e) => {
        console.error("Background video playback error", e);
        if (mediaRecorder.state === 'recording') mediaRecorder.stop();
        reject(new Error("Background video playback error"));
    };

    const draw = () => {
      if (!isRecording) return;
      
      // Stop if background video ended (double check)
      if (bgVideo.ended) {
          if (mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
          }
          return;
      }

      // Draw Background (Gameplay)
      // Clear canvas first
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, width, height);

      try {
          // Only draw if we have a frame
          if (bgVideo.readyState >= 2) {
              ctx.drawImage(bgVideo, bgOffsetX, bgOffsetY, bgDrawWidth, bgDrawHeight);
          }
      } catch (e) {
          // console.warn("Frame draw error (bg)", e);
      }

      // Draw Overlay (Streamer)
      try {
          // Only draw if we have a frame
          if (overlayVideo.readyState >= 2) {
             if (layout === 'classic-pip') {
             // Rounded Corners & White Border
             ctx.save();
             
             // Define rounded path
             const radius = 20;
             ctx.beginPath();
             ctx.moveTo(overlayX + radius, overlayY);
             ctx.lineTo(overlayX + overlayWidth - radius, overlayY);
             ctx.quadraticCurveTo(overlayX + overlayWidth, overlayY, overlayX + overlayWidth, overlayY + radius);
             ctx.lineTo(overlayX + overlayWidth, overlayY + overlayHeight - radius);
             ctx.quadraticCurveTo(overlayX + overlayWidth, overlayY + overlayHeight, overlayX + overlayWidth - radius, overlayY + overlayHeight);
             ctx.lineTo(overlayX + radius, overlayY + overlayHeight);
             ctx.quadraticCurveTo(overlayX, overlayY + overlayHeight, overlayX, overlayY + overlayHeight - radius);
             ctx.lineTo(overlayX, overlayY + radius);
             ctx.quadraticCurveTo(overlayX, overlayY, overlayX + radius, overlayY);
             ctx.closePath();
             
             // Shadow
             ctx.shadowColor = "rgba(0,0,0,0.5)";
             ctx.shadowBlur = 20;
             
             // Clip and Draw Image
             ctx.save();
             ctx.clip();
             if (!overlayVideo.ended) {
                 ctx.drawImage(overlayVideo, overlayX, overlayY, overlayWidth, overlayHeight);
             } else {
                 ctx.fillStyle = 'black';
                 ctx.fillRect(overlayX, overlayY, overlayWidth, overlayHeight);
             }
             ctx.restore();
             
             // Draw Border
             ctx.shadowBlur = 0;
             ctx.strokeStyle = "white";
             ctx.lineWidth = 6;
             ctx.stroke();
             
             ctx.restore();

         } else if (layout === 'stacked') {
             // For stacked, we usually want to "Cover" the slot with the streamer video too
             // Calculate streamer cover logic
             const streamerRatio = overlayVideo.videoWidth / overlayVideo.videoHeight;
             const slotRatio = overlayWidth / overlayHeight;
             
             let sDrawWidth, sDrawHeight, sOffsetX, sOffsetY;
             
             if (streamerRatio > slotRatio) {
                 // Streamer wider than slot -> Crop sides
                 sDrawHeight = overlayHeight;
                 sDrawWidth = overlayHeight * streamerRatio;
                 sOffsetX = overlayX + (overlayWidth - sDrawWidth) / 2;
                 sOffsetY = overlayY;
             } else {
                 // Streamer taller than slot -> Crop top/bottom
                 sDrawWidth = overlayWidth;
                 sDrawHeight = overlayWidth / streamerRatio;
                 sOffsetX = overlayX;
                 sOffsetY = overlayY + (overlayHeight - sDrawHeight) / 2;
             }
             
             // Save context to clip to the slot
             ctx.save();
             ctx.beginPath();
             ctx.rect(overlayX, overlayY, overlayWidth, overlayHeight);
             ctx.clip();
             
             if (!overlayVideo.ended) {
                 ctx.drawImage(overlayVideo, sOffsetX, sOffsetY, sDrawWidth, sDrawHeight);
             } else {
                 ctx.fillStyle = 'black';
                 ctx.fillRect(sOffsetX, sOffsetY, sDrawWidth, sDrawHeight);
             }
             
             ctx.restore();
             
             // Draw a separator line
             ctx.strokeStyle = "#000";
             ctx.lineWidth = 4;
             if (targetRatio === '9:16') {
                 // Horizontal line
                 ctx.beginPath();
                 if (stackedPlacement === 'top') {
                    ctx.moveTo(0, overlayHeight);
                    ctx.lineTo(width, overlayHeight);
                 } else {
                    ctx.moveTo(0, overlayY);
                    ctx.lineTo(width, overlayY);
                 }
                 ctx.stroke();
             } else {
                 // Vertical line
                 ctx.beginPath();
                 if (stackedPlacement === 'left') {
                    ctx.moveTo(overlayWidth, 0);
                    ctx.lineTo(overlayWidth, height);
                 } else {
                    ctx.moveTo(overlayX, 0);
                    ctx.lineTo(overlayX, height);
                 }
                 ctx.stroke();
             }
         }
      }
      } catch (e) {
          console.warn("Frame draw error (overlay)", e);
      }

      animationFrameId = requestAnimationFrame(draw);
    };

    mediaRecorder.start();
    isRecording = true;

    // Start playback
    try {
        // Ensure both are ready and seeked to start
        bgVideo.currentTime = 0;
        overlayVideo.currentTime = 0;
        
        await Promise.all([bgVideo.play(), overlayVideo.play()]);
        draw();
    } catch (e) {
        console.warn("Autoplay blocked/failed. Attempting fallback.", e);
        
        // Try resuming context again if play failed, just in case
        if (audioCtx.state === 'suspended') {
            try { await audioCtx.resume(); } catch(resErr) { console.error(resErr); }
        }

        // Fallback: Mute elements (HTML video requirement for autoplay without gesture)
        // If AudioContext is running, we might still get audio if we are lucky with cross-origin policies,
        // but often muted elements yield silence. This prevents the HANG though.
        bgVideo.muted = true;
        overlayVideo.muted = true;
        
        try {
            await Promise.all([bgVideo.play(), overlayVideo.play()]);
            draw();
        } catch (e2) {
            console.error("Playback failed completely", e2);
            mediaRecorder.stop();
            reject(new Error("Video playback failed. Browser blocked autoplay."));
        }
    }
  });
};
