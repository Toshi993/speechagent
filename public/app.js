/* ============================================
   Speech Analyst – app.js v9
   Echtzeit-Sprachanalyse via Web Speech API
   - Füllwort-Erkennung: Unicode-Normalisierung
   ============================================ */

(function() {
  'use strict';

  // DOM-Referenzen
  var micButton     = document.getElementById('micButton');
  var micStatus     = document.getElementById('micStatus');
  var wpmDisplay    = document.getElementById('wpmDisplay');
  var feedbackDisp  = document.getElementById('feedbackDisplay');
  var fillerCountEl = document.getElementById('fillerCount');
  var fillerDensity = document.getElementById('fillerDensity');
  var fillerWarning = document.getElementById('fillerWarning');
  var transcriptEl  = document.getElementById('transcript');
  var resetButton   = document.getElementById('resetButton');

  // === NEUE DOM-Referenzen für Pausen-, Tonalitäts- und Lautstärke-Analyse ===
  var currentPauseDisplay = document.getElementById('currentPauseDisplay');
  var averagePauseDisplay = document.getElementById('averagePauseDisplay');
  var pauseClassDisplay   = document.getElementById('pauseClassDisplay');
  var tonalityDisplay     = document.getElementById('tonalityDisplay');
  var tonalityIndicator   = document.getElementById('tonalityIndicator');
  var loudnessBar         = document.getElementById('loudnessBar');
  var loudnessDisplay     = document.getElementById('loudnessDisplay');

  // Konfiguration
  var FILLER_VARIANTS = {
    'ae': true, 'aeh': true, 'aehm': true, 'aehhm': true, 'aehhhm': true,
    'a': true, 'aah': true, 'aam': true, 'aem': true,
    'e': true, 'eh': true, 'ehm': true, 'eehm': true, 'eeeh': true,
    'u': true, 'uh': true, 'uhm': true, 'uum': true, 'uehm': true,
    'o': true, 'oh': true, 'ohm': true,
    'hm': true, 'hmm': true, 'hmmm': true,
    'mh': true, 'mhm': true, 'mmhm': true, 'mmh': true, 'mmmh': true,
    'tja': true, 'naja': true, 'nun': true,
    'also': true, 'quasi': true, 'halt': true,
    'irgendwie': true, 'eigentlich': true,
    'sozusagen': true, 'praktisch': true, 'sprich': true
  };

  var WPM_SLOW_MAX   = 110;
  var WPM_FAST_MIN   = 150;
  var FILLER_WARN_THRESHOLD = 0.10;
  var WPM_INTERVAL_MS = 2000;
  var WPM_WINDOW_SEC = 10;
  var SILENCE_TIMEOUT_MS = 18000;

  // Zustand
  var recognition     = null;
  var isRecording     = false;
  var fullTranscript  = '';
  var wordCount       = 0;
  var fillerCount     = 0;
  var sessionStart    = null;
  var wpmTimer        = null;
  var lastResultTime  = 0;
  var silenceTimer    = null;
  var restartTimeout  = null;

  // === AUDIO-INFRASTRUKTUR (für Pausen-, Tonalitäts- und Lautstärke-Analyse) ===
  var audioContext     = null;
  var analyser         = null;
  var micStream        = null;
  var audioAnalysisId  = null;
  var timeDomainData   = null;

  // === PAUSEN-ANALYSE – Zustand ===
  var PAUSE_RMS_THRESHOLD   = 0.015;
  var PAUSE_MIN_DURATION_MS = 300;
  var isInPause           = false;
  var pauseStartTime      = 0;
  var pauseDurations      = [];
  var currentPauseDuration = 0;

  // === TONALITÄTS-ANALYSE – Zustand ===
  var TONE_HISTORY_SIZE        = 30;
  var TONE_VARIANCE_THRESHOLD  = 50;
  var TONE_TREND_THRESHOLD     = 20;
  var pitchHistory            = [];

  // === LAUTSTÄRKE-ANALYSE – Zustand ===
  var LOUDNESS_QUIET_MAX = 0.02;
  var LOUDNESS_LOUD_MIN  = 0.10;

  // SpeechRecognition Factory
  function createRecognition() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micStatus.textContent = 'Bitte Chrome/Edge verwenden';
      micButton.disabled = true;
      return null;
    }

    var rec = new SR();
    rec.lang = 'de-DE';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    return rec;
  }

  // Handler
  function onStart() {
    console.log('[SA] recognition gestartet');
    micStatus.textContent = 'Höre zu...';
  }

  function onEnd() {
    if (!isRecording) return;

    if (restartTimeout) clearTimeout(restartTimeout);
    restartTimeout = setTimeout(function() {
      restartTimeout = null;
      if (!isRecording) return;

      recognition = createRecognition();
      if (!recognition) return;

      recognition.onstart  = onStart;
      recognition.onend    = onEnd;
      recognition.onresult = onResult;
      recognition.onerror  = onError;

      try {
        recognition.start();
      } catch (e) {
        console.warn('[SA] Neustart fehlgeschlagen:', e.message);
        recognition = null;
        isRecording = false;
      }
    }, 300);
  }

  function onResult(event) {
    var interim = '';
    var final   = '';

    for (var i = event.resultIndex; i < event.results.length; i++) {
      var result = event.results[i];
      var text = result[0].transcript.trim();

      if (result.isFinal) {
        final += text + ' ';
      } else {
        interim += text;
      }
    }

    if (final) {
      fullTranscript += final;
    }

    var visibleText = fullTranscript + interim;

    // Wörter zählen: nur Satzzeichen entfernen, Umlaute bleiben
    var cleaned = visibleText.replace(/[.,!?;:()"'\u2014\u2013]/g, '');
    var words = cleaned.split(/\s+/).filter(function(w) { return w.length > 0; });

    wordCount = words.length;
    fillerCount = countFillers(words);

    transcriptEl.textContent = visibleText || '...';
    updateFillerUI();

    lastResultTime = Date.now();
  }

  function onError(event) {
    if (event.error === 'not-allowed') {
      micStatus.textContent = 'Mikrofon nicht erlaubt';
      isRecording = false;
    } else if (event.error === 'audio-capture') {
      micStatus.textContent = 'Kein Mikrofon gefunden';
      isRecording = false;
    } else if (event.error === 'service-not-allowed') {
      micStatus.textContent = 'Dienst blockiert';
      isRecording = false;
    } else if (event.error === 'network') {
      micStatus.textContent = 'Netzwerkfehler – Neustart...';
    }
  }

  // Stille-Erkennung
  function checkSilence() {
    if (!isRecording) return;

    var elapsed = Date.now() - lastResultTime;
    if (elapsed > SILENCE_TIMEOUT_MS) {
      if (recognition) {
        try { recognition.abort(); } catch (_) {}
        recognition = null;
      }

      recognition = createRecognition();
      if (!recognition) {
        isRecording = false;
        return;
      }

      recognition.onstart  = onStart;
      recognition.onend    = onEnd;
      recognition.onresult = onResult;
      recognition.onerror  = onError;

      try {
        recognition.start();
        lastResultTime = Date.now();
      } catch (e) {
        console.warn('[SA] Stille-Neustart fehlgeschlagen:', e.message);
      }
    }
  }

  // >>> FÜLLWORT-ERKENNUNG – NEU IN v9 <<<
  // Problem: Die Web Speech API kann "ähm" als "ähm", "aehm", "ehm", "e", "ä" 
  // oder "a" transkribieren. 
  // Lösung: Wir normalisieren jedes Wort VOR der Prüfung:
  //   ä → ae, ö → oe, ü → ue, ß → ss
  // Dann prüfen wir gegen eine vollständige Liste aller möglichen Varianten.
  function normalizeWord(word) {
    var w = word.toLowerCase();
    var result = '';
    for (var j = 0; j < w.length; j++) {
      var c = w.charCodeAt(j);
      // a=97, e=101, h=104, m=109, o=111, u=117 – ASCII-Buchstaben
      // ae=97+101, oe=111+101, ue=117+101, ss=115+115
      // Unicode-Umlaute als Ersatz: a-Umlaut (228) -> ae, o-Umlaut (246) -> oe, u-Umlaut (252) -> ue, szlig (223) -> ss
      if (c === 228) { result += 'ae'; }      // ä
      else if (c === 246) { result += 'oe'; } // ö
      else if (c === 252) { result += 'ue'; } // ü
      else if (c === 223) { result += 'ss'; } // ß
      else if (c === 196) { result += 'ae'; } // Ä
      else if (c === 214) { result += 'oe'; } // Ö
      else if (c === 220) { result += 'ue'; } // Ü
      else { result += w.charAt(j); }
    }
    return result;
  }

  function isFillerWord(word) {
    // Erst normalisieren (Umlaute → ASCII)
    var w = normalizeWord(word);
    
    // Satzzeichen entfernen
    w = w.replace(/[.,!?;:()"'\u2014\u2013]/g, '').trim();
    
    if (w.length === 0) return false;

    // 1. Direkter Match in der Varianten-Liste
    if (FILLER_VARIANTS[w]) return true;

    // 2. Kurze Wörter (1-4 Zeichen): bestehen sie NUR aus a,e,u,h,m,o?
    if (w.length <= 4) {
      if (/^[aeuohm]+$/i.test(w)) return true;
    }

    // 3. Bekannte längere Füllwörter
    if (/^(tja|naja|nun|also|quasi|halt|irgendwie|eigentlich|sozusagen|praktisch|sprich)$/i.test(w)) return true;

    return false;
  }

  function countFillers(words) {
    var count = 0;
    for (var i = 0; i < words.length; i++) {
      if (isFillerWord(words[i])) {
        count++;
      }
    }
    return count;
  }

  // UI-Updates
  function updateFillerUI() {
    fillerCountEl.textContent = fillerCount;
    var density = wordCount > 0 ? (fillerCount / wordCount) : 0;
    fillerDensity.textContent = (density * 100).toFixed(1) + '%';

    if (density >= FILLER_WARN_THRESHOLD) {
      fillerWarning.classList.remove('hidden');
    } else {
      fillerWarning.classList.add('hidden');
    }
  }

  function updateWPM() {
    if (!sessionStart || wordCount === 0) {
      wpmDisplay.textContent = '0';
      feedbackDisp.textContent = '\u2014';
      return;
    }

    var elapsedSeconds = (Date.now() - sessionStart) / 1000;
    if (elapsedSeconds < 3) return;

    var windowSeconds = Math.min(elapsedSeconds, WPM_WINDOW_SEC);
    var wordsInWindow = wordCount * (windowSeconds / elapsedSeconds);
    var wpm = Math.round(wordsInWindow / (windowSeconds / 60));
    var clamped = Math.min(Math.max(wpm, 0), 400);

    wpmDisplay.textContent = clamped;

    var feedbackText, feedbackClass;
    if (clamped < WPM_SLOW_MAX) {
      feedbackText   = 'Schneller reden \u2B06\uFE0F';
      feedbackClass  = 'slow';
    } else if (clamped <= WPM_FAST_MIN) {
      feedbackText   = 'Gut so \u2705';
      feedbackClass  = 'good';
    } else {
      feedbackText   = 'Langsamer reden \u2B07\uFE0F';
      feedbackClass  = 'fast';
    }

    feedbackDisp.textContent = feedbackText;
    feedbackDisp.className = 'metric-value feedback ' + feedbackClass;
  }

  // ============================================================
  // === LAUTSTÄRKE-ANALYSE (RMS berechnen) ===
  // ============================================================
  function calculateRMS(timeDomainData) {
    var sum = 0;
    for (var i = 0; i < timeDomainData.length; i++) {
      sum += timeDomainData[i] * timeDomainData[i];
    }
    return Math.sqrt(sum / timeDomainData.length);
  }

  function classifyLoudness(rms) {
    if (rms < LOUDNESS_QUIET_MAX) {
      return { label: 'Leise', className: 'loudness-quiet', percent: Math.min(rms / LOUDNESS_QUIET_MAX * 33, 33) };
    }
    if (rms <= LOUDNESS_LOUD_MIN) {
      return { label: 'Normal', className: 'loudness-normal', percent: 33 + (rms - LOUDNESS_QUIET_MAX) / (LOUDNESS_LOUD_MIN - LOUDNESS_QUIET_MAX) * 34 };
    }
    return { label: 'Laut', className: 'loudness-loud', percent: Math.min(67 + (rms - LOUDNESS_LOUD_MIN) / 0.20 * 33, 100) };
  }

  function updateLoudnessUI(rms) {
    var cls = classifyLoudness(rms);
    loudnessBar.style.width = cls.percent + '%';
    loudnessDisplay.textContent = cls.label;
    loudnessDisplay.className = 'metric-value small ' + cls.className;
  }

  // ============================================================
  // === PAUSEN-ANALYSE ===
  // ============================================================
  function detectPause(rms, now) {
    if (rms < PAUSE_RMS_THRESHOLD) {
      // Stille erkannt
      if (!isInPause) {
        isInPause = true;
        pauseStartTime = now;
      }
      currentPauseDuration = (now - pauseStartTime) / 1000;
    } else {
      // Sprache erkannt – Pause beendet
      if (isInPause) {
        var durationSec = (now - pauseStartTime) / 1000;
        if (durationSec >= PAUSE_MIN_DURATION_MS / 1000) {
          pauseDurations.push(durationSec);
        }
        isInPause = false;
        currentPauseDuration = 0;
      }
    }
  }

  function classifyPause(durationSec) {
    if (durationSec < 1.0) return { label: 'Kurz', className: 'short' };
    if (durationSec <= 3.0) return { label: 'Mittel', className: 'medium' };
    return { label: 'Lang', className: 'long' };
  }

  function updatePauseUI() {
    var avg = pauseDurations.length > 0
      ? pauseDurations.reduce(function(a, b) { return a + b; }, 0) / pauseDurations.length
      : 0;
    currentPauseDisplay.textContent = currentPauseDuration.toFixed(1).replace('.', ',') + ' s';
    averagePauseDisplay.textContent = avg.toFixed(1).replace('.', ',') + ' s';
    var cls = classifyPause(currentPauseDuration);
    pauseClassDisplay.textContent = isInPause ? cls.label : '—';
    pauseClassDisplay.className = 'indicator ' + (isInPause ? cls.className : '');
  }

  // ============================================================
  // === TONALITÄTS-ANALYSE (Pitch via Autokorrelation) ===
  // ============================================================
  function estimatePitch(timeDomainData, sampleRate) {
    var buflen = timeDomainData.length;
    var bestOffset = -1;
    var bestCorr = 0;
    var rms = 0;
    for (var i = 0; i < buflen; i++) rms += timeDomainData[i] * timeDomainData[i];
    rms = Math.sqrt(rms / buflen);
    if (rms < 0.01) return 0; // zu leise, kein Ton erkennbar

    var maxOffset = Math.floor(sampleRate / 80);  // tiefste Frequenz ~80 Hz
    var minOffset = Math.floor(sampleRate / 400); // höchste Frequenz ~400 Hz
    for (var offset = minOffset; offset <= maxOffset; offset++) {
      var corr = 0;
      for (var i = 0; i < buflen - offset; i++) {
        corr += timeDomainData[i] * timeDomainData[i + offset];
      }
      if (corr > bestCorr) { bestCorr = corr; bestOffset = offset; }
    }
    return bestOffset > 0 ? sampleRate / bestOffset : 0;
  }

  function updateTonality(pitchHz) {
    if (pitchHz > 0) pitchHistory.push(pitchHz);
    if (pitchHistory.length > TONE_HISTORY_SIZE) pitchHistory.shift();
    if (pitchHistory.length < 5) {
      tonalityDisplay.textContent = '—';
      tonalityIndicator.textContent = 'Unbekannt';
      tonalityIndicator.className = 'indicator';
      return;
    }
    var avg = pitchHistory.reduce(function(a, b) { return a + b; }, 0) / pitchHistory.length;
    var variance = pitchHistory.reduce(function(sum, p) { return sum + Math.pow(p - avg, 2); }, 0) / pitchHistory.length;
    var half = Math.floor(pitchHistory.length / 2);
    var first = pitchHistory.slice(0, half);
    var second = pitchHistory.slice(half);
    var avg1 = first.reduce(function(a, b) { return a + b; }, 0) / first.length;
    var avg2 = second.reduce(function(a, b) { return a + b; }, 0) / second.length;

    var label, className;
    if (variance < TONE_VARIANCE_THRESHOLD) {
      label = 'Monoton'; className = 'tone-monotone';
    } else if (avg2 - avg1 > TONE_TREND_THRESHOLD) {
      label = 'Steigend'; className = 'tone-rising';
    } else if (avg1 - avg2 > TONE_TREND_THRESHOLD) {
      label = 'Fallend'; className = 'tone-falling';
    } else {
      label = 'Variiert'; className = 'tone-varied';
    }
    tonalityDisplay.textContent = Math.round(avg) + ' Hz';
    tonalityIndicator.textContent = label;
    tonalityIndicator.className = 'indicator ' + className;
  }

  // ============================================================
  // === AUDIO-INFRASTRUKTUR – Analyse-Loop ===
  // ============================================================
  function initAudioContext(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    timeDomainData = new Float32Array(analyser.fftSize);
    var source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    // Nicht mit destination verbinden – verhindert Rückkopplung
  }

  function runAudioAnalysis() {
    if (!isRecording || !analyser) return;
    analyser.getFloatTimeDomainData(timeDomainData);
    var rms = calculateRMS(timeDomainData);
    var now = Date.now();

    // Pausen-Analyse
    detectPause(rms, now);
    updatePauseUI();

    // Tonalitäts-Analyse
    var pitch = estimatePitch(timeDomainData, audioContext.sampleRate);
    updateTonality(pitch);

    // Lautstärke-Analyse
    updateLoudnessUI(rms);

    audioAnalysisId = requestAnimationFrame(runAudioAnalysis);
  }

  // Aufnahme-Steuerung
  function startRecording() {
    if (recognition) {
      try { recognition.abort(); } catch (_) {}
      recognition = null;
    }

    recognition = createRecognition();
    if (!recognition) return;

    recognition.onstart  = onStart;
    recognition.onend    = onEnd;
    recognition.onresult = onResult;
    recognition.onerror  = onError;

    isRecording = true;
    fullTranscript = '';
    wordCount   = 0;
    fillerCount = 0;
    sessionStart = Date.now();
    lastResultTime = Date.now();

    micButton.classList.add('recording');
    micStatus.textContent = 'Starte Mikrofon...';
    fillerWarning.classList.add('hidden');
    transcriptEl.textContent = '...';
    wpmDisplay.textContent = '0';
    feedbackDisp.textContent = '\u2014';
    feedbackDisp.className = 'metric-value feedback';

    if (wpmTimer) clearInterval(wpmTimer);
    wpmTimer = setInterval(updateWPM, WPM_INTERVAL_MS);

    if (silenceTimer) clearInterval(silenceTimer);
    silenceTimer = setInterval(checkSilence, 5000);

    // === AUDIO-INFRASTRUKTUR STARTEN (gleicher Mikrofon-Zugriff) ===
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        micStream = stream;
        initAudioContext(stream);
        runAudioAnalysis();

        // Spracherkennung starten (nachdem Mikrofon-Zugriff gewährt wurde)
        try {
          recognition.start();
          console.log('[SA] start() aufgerufen');
        } catch (e) {
          console.warn('[SA] start() fehlgeschlagen:', e.message);
          recognition = null;
          micStatus.textContent = 'Start fehlgeschlagen';
          isRecording = false;
        }
      })
      .catch(function(err) {
        console.warn('[SA] getUserMedia fehlgeschlagen:', err.message);
        micStatus.textContent = 'Mikrofon-Zugriff verweigert';
        isRecording = false;
        micButton.classList.remove('recording');
        recognition = null;
      });
  }

  function stopRecording() {
    isRecording = false;
    micButton.classList.remove('recording');
    micStatus.textContent = 'Gestoppt';

    if (restartTimeout) {
      clearTimeout(restartTimeout);
      restartTimeout = null;
    }

    if (wpmTimer) {
      clearInterval(wpmTimer);
      wpmTimer = null;
    }

    if (silenceTimer) {
      clearInterval(silenceTimer);
      silenceTimer = null;
    }

    if (recognition) {
      try {
        recognition.abort();
        console.log('[SA] abort() aufgerufen');
      } catch (e) {}
      recognition = null;
    }

    // === AUDIO-RESSOURCEN FREIGEBEN ===
    if (audioAnalysisId) {
      cancelAnimationFrame(audioAnalysisId);
      audioAnalysisId = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(function() {});
      audioContext = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(function(track) { track.stop(); });
      micStream = null;
    }
    analyser = null;
  }

  function resetSession() {
    stopRecording();

    fullTranscript = '';
    wordCount   = 0;
    fillerCount = 0;
    sessionStart = null;

    wpmDisplay.textContent = '0';
    feedbackDisp.textContent = '\u2014';
    feedbackDisp.className = 'metric-value feedback';
    fillerCountEl.textContent = '0';
    fillerDensity.textContent = '0%';
    fillerWarning.classList.add('hidden');
    transcriptEl.textContent = '...';
    micStatus.textContent = 'Klicke zum Starten';

    // === NEUE UI-ELEMENTE ZURÜCKSETZEN ===
    pitchHistory = [];
    pauseDurations = [];
    currentPauseDuration = 0;
    isInPause = false;
    pauseStartTime = 0;
    currentPauseDisplay.textContent = '0,0 s';
    averagePauseDisplay.textContent = '0,0 s';
    pauseClassDisplay.textContent = '—';
    pauseClassDisplay.className = 'indicator';
    tonalityDisplay.textContent = '—';
    tonalityIndicator.textContent = 'Monoton';
    tonalityIndicator.className = 'indicator tone-monotone';
    loudnessBar.style.width = '0%';
    loudnessDisplay.textContent = '—';
    loudnessDisplay.className = 'metric-value small';
  }

  // Event-Bindungen
  micButton.addEventListener('click', function() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  resetButton.addEventListener('click', resetSession);

  // Initialisierung
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micStatus.textContent = 'Bitte Chrome/Edge verwenden';
    micButton.disabled = true;
  }

  window.addEventListener('beforeunload', function() {
    if (isRecording && recognition) {
      try { recognition.abort(); } catch (_) {}
    }
    // Auch Audio-Ressourcen beim Schließen bereinigen
    if (audioAnalysisId) {
      cancelAnimationFrame(audioAnalysisId);
    }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(function() {});
    }
    if (micStream) {
      micStream.getTracks().forEach(function(track) { track.stop(); });
    }
  });

  console.log('[SA] Speech Analyst v9 – Unicode-Normalisierung für Füllwörter + Audio-Analyse');

})();