document.addEventListener('alpine:init', () => {
    Alpine.data('videoPlayer', () => ({
        player: null,
        qualities: [],
        audioTracks: [],
        selectedQuality: '',
        selectedAudio: '',
        playbackRate: '1',
        pipSupported: false,
        currentSource: null,
        _keyboardHandler: null,
        _videoDataHandler: null,

        init() {
            this.pipSupported = 'pictureInPictureEnabled' in document;
            this._currentVideoId = null;

            this._videoDataHandler = (event) => this.initPlayer(event.detail);
            window.addEventListener('watch:video-loaded', this._videoDataHandler);

            // Keyboard shortcuts - bind handler for cleanup
            this._keyboardHandler = (e) => this.handleKeyboard(e);
            document.addEventListener('keydown', this._keyboardHandler);
        },

        destroy() {
            if (this._keyboardHandler) {
                document.removeEventListener('keydown', this._keyboardHandler);
            }
            if (this._videoDataHandler) {
                window.removeEventListener('watch:video-loaded', this._videoDataHandler);
            }
            if (this.player) {
                this.player = null;
            }
        },

        initPlayer(data) {
            // Check if this is the same video (prevent double-loading).
            const videoId = data.videoId || data.id || data.title;
            if (this._currentVideoId === videoId && this.player) {
                return;
            }
            this._currentVideoId = videoId;

            // The v10 web component owns the controls; retain the media element for source changes.
            if (this.player) {
                this.player = null;
            }

            const videoEl = this.$refs.videoElement;
            if (!videoEl) {
                return;
            }

            // Parse available formats
            this.parseFormats(data);

            this.player = videoEl;

            // Handle errors
            this.player.addEventListener('error', () => {
                const error = this.player.error;
                console.error('[Player] Video playback error:', error);
            });

            this.player.addEventListener('canplay', () => {
                if (Alpine.store('watch').autoplay) {
                    this.player.play().catch(() => {});
                }
            }, { once: true });

            // Set initial source after player event handlers are registered.
            this.setSource(data);
        },

        parseFormats(data) {
            this.qualities = [];
            this.audioTracks = [];

            // Check for HLS first
            if (data.hlsUrl) {
                this.qualities.push({
                    itag: 'hls',
                    label: 'Auto (HLS)',
                    url: data.hlsUrl,
                    type: 'application/x-mpegURL'
                });
            }

            // Add muxed formats (formatStreams)
            if (data.formatStreams && data.formatStreams.length > 0) {
                data.formatStreams.forEach(f => {
                    const label = f.quality || f.resolution || 'Unknown';
                    this.qualities.push({
                        itag: f.itag,
                        label: `${label} (${f.container})`,
                        url: f.url,
                        type: this.getMimeType(f),
                        container: f.container
                    });
                });
            }

            // Add adaptive video formats with codec priority
            if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
                const videoFormats = data.adaptiveFormats
                    .filter(f => f.type && f.type.startsWith('video/'))
                    .sort((a, b) => {
                        // Sort by resolution (height) descending, then by codec priority
                        const heightA = a.height || 0;
                        const heightB = b.height || 0;
                        if (heightB !== heightA) return heightB - heightA;
                        return this.codecPriority(b.type) - this.codecPriority(a.type);
                    });

                // Group by resolution, prefer VP9/AV1
                const seenResolutions = new Set();
                videoFormats.forEach(f => {
                    const height = f.height || 0;
                    const resKey = `${height}p`;

                    // Check if browser supports this codec
                    if (!this.isTypeSupported(f.type)) return;

                    if (!seenResolutions.has(resKey) || this.codecPriority(f.type) > 1) {
                        seenResolutions.add(resKey);
                        const codecName = this.getCodecName(f.type);
                        const fpsLabel = f.fps > 30 ? ` ${f.fps}fps` : '';
                        this.qualities.push({
                            itag: f.itag,
                            label: `${f.resolution || resKey}${fpsLabel} (${codecName})`,
                            url: f.url,
                            type: f.type,
                            container: f.container,
                            height: height,
                            isAdaptive: true
                        });
                    }
                });

                // Get audio tracks
                const audioFormats = data.adaptiveFormats
                    .filter(f => f.type && f.type.startsWith('audio/'))
                    .sort((a, b) => {
                        // Sort by bitrate descending
                        const bitrateA = parseInt(a.bitrate) || 0;
                        const bitrateB = parseInt(b.bitrate) || 0;
                        return bitrateB - bitrateA;
                    });

                audioFormats.forEach(f => {
                    if (!this.isTypeSupported(f.type)) return;

                    const label = f.audioTrack?.displayName ||
                                  f.audioQuality ||
                                  (f.bitrate ? `${f.bitrate}` : 'Audio');
                    this.audioTracks.push({
                        itag: f.itag,
                        label: `${label} (${f.container})`,
                        url: f.url,
                        type: f.type
                    });
                });
            }

            // Set default selections
            if (this.qualities.length > 0) {
                // Prefer HLS, then best muxed format, then best adaptive
                const hlsFormat = this.qualities.find(q => q.itag === 'hls');
                const muxedFormat = this.qualities.find(q => !q.isAdaptive && q.itag !== 'hls');
                this.selectedQuality = hlsFormat?.itag || muxedFormat?.itag || this.qualities[0].itag;
            }

            if (this.audioTracks.length > 0) {
                this.selectedAudio = this.audioTracks[0].itag;
            }
        },

        codecPriority(type) {
            if (!type) return 0;
            if (type.includes('av01')) return 3;  // AV1
            if (type.includes('vp9') || type.includes('vp09')) return 2;  // VP9
            if (type.includes('avc1') || type.includes('h264')) return 1;  // H.264
            return 0;
        },

        getCodecName(type) {
            if (!type) return 'Unknown';
            if (type.includes('av01')) return 'AV1';
            if (type.includes('vp9') || type.includes('vp09')) return 'VP9';
            if (type.includes('avc1') || type.includes('h264')) return 'H.264';
            if (type.includes('opus')) return 'Opus';
            if (type.includes('mp4a')) return 'AAC';
            return type.split(';')[0].split('/')[1] || 'Unknown';
        },

        isTypeSupported(type) {
            if (!type) return false;
            if (typeof MediaSource === 'undefined') return true;  // Fallback
            try {
                return MediaSource.isTypeSupported(type);
            } catch {
                return true;  // Assume supported if check fails
            }
        },

        getMimeType(format) {
            if (format.type) return format.type.split(';')[0];
            const container = format.container?.toLowerCase() || '';
            if (container === 'mp4') return 'video/mp4';
            if (container === 'webm') return 'video/webm';
            if (container === 'hls' || container === 'm3u8') return 'application/x-mpegURL';
            return 'video/mp4';
        },

        setSource(data) {
            if (!this.player) return;

            let source = null;

            // Try HLS first
            if (data.hlsUrl) {
                source = {
                    src: data.hlsUrl,
                    type: 'application/x-mpegURL'
                };
            }
            // Try selected quality
            else if (this.selectedQuality) {
                const quality = this.qualities.find(q => q.itag === this.selectedQuality);
                if (quality) {
                    source = {
                        src: quality.url,
                        type: quality.type || 'video/mp4'
                    };
                }
            }
            // Fallback to first format stream
            else if (data.formatStreams && data.formatStreams.length > 0) {
                const f = data.formatStreams[0];
                source = {
                    src: f.url,
                    type: this.getMimeType(f)
                };
            }
            // Fallback to first adaptive format
            else if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
                const videoFormat = data.adaptiveFormats.find(f => f.type?.startsWith('video/'));
                if (videoFormat) {
                    source = {
                        src: videoFormat.url,
                        type: videoFormat.type
                    };
                }
            }

            if (source) {
                this.currentSource = source;
                this.player.src = source.src;
                this.player.load();

                // Set poster
                if (data.videoThumbnails && data.videoThumbnails.length > 0) {
                    const poster = data.videoThumbnails.find(t => t.quality === 'maxres') ||
                                   data.videoThumbnails.find(t => t.quality === 'high') ||
                                   data.videoThumbnails[0];
                    if (poster) {
                        this.player.poster = poster.url;
                    }
                }
            }
        },

        changeQuality() {
            if (!this.player || !this.selectedQuality) return;

            const quality = this.qualities.find(q => q.itag === this.selectedQuality);
            if (!quality) return;

            const currentTime = this.player.currentTime;
            const wasPlaying = !this.player.paused;

            this.player.src = quality.url;
            this.player.load();

            this.player.addEventListener('loadedmetadata', () => {
                this.player.currentTime = currentTime;
                if (wasPlaying) {
                    this.player.play().catch(() => {});
                }
            }, { once: true });
        },

        changeAudio() {
            // Note: Separate audio track selection requires MSE/MediaSource
            // For now, this is a placeholder - full implementation would need
            // to handle audio/video muxing on the client side
            // Note: Full implementation would need audio/video muxing on the client side
        },

        changeSpeed() {
            if (this.player) {
                this.player.playbackRate = parseFloat(this.playbackRate);
            }
        },

        togglePip() {
            const videoEl = this.player;
            if (!videoEl) return;

            if (document.pictureInPictureElement) {
                document.exitPictureInPicture();
            } else if (videoEl.requestPictureInPicture) {
                videoEl.requestPictureInPicture();
            }
        },

        handleKeyboard(e) {
            if (!this.player) return;

            // Ignore if typing in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.key.toLowerCase()) {
                case ' ':
                    e.preventDefault();
                    this.player.paused ? this.player.play() : this.player.pause();
                    break;
                case 'arrowleft':
                    e.preventDefault();
                    this.player.currentTime = Math.max(0, this.player.currentTime - 10);
                    break;
                case 'arrowright':
                    e.preventDefault();
                    this.player.currentTime += 10;
                    break;
                case 'arrowup':
                    e.preventDefault();
                    this.player.volume = Math.min(1, this.player.volume + 0.1);
                    break;
                case 'arrowdown':
                    e.preventDefault();
                    this.player.volume = Math.max(0, this.player.volume - 0.1);
                    break;
                case 'f':
                    e.preventDefault();
                    document.fullscreenElement ? document.exitFullscreen() : this.player.closest('video-player')?.requestFullscreen();
                    break;
                case 'm':
                    e.preventDefault();
                    this.player.muted = !this.player.muted;
                    break;
            }
        }
    }));
});
