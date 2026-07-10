/* ============================================
   Speech Analyst – app.js v12
   Echtzeit-Sprachanalyse via Web Speech API
   - Füllwort-Erkennung: Unicode-Normalisierung
   - Zeitbasierter Moving Average (10s / 20s)
   - Text-Feedback in deutscher Sprache
   - Pitch-Glättung: Median-Filter + Delta-Limit + 190 Hz Cap
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
  var 123

  // === NEUE DOM-Referenzen für Pausen-, Tonalitäts- und Lautstärke-Analyse ===
  var currentPauseDisplay = document.getElementById('currentPauseDisplay');
  var averagePauseDisplay = document.getElementById('averagePauseDisplay');
  var pauseClassDisplay   = document.getElementById('pauseClassDisplay');
  var tonalityDisplay     = document.getElementById('tonalityDisplay');
  var tonalityIndicator   = document.getElementById('tonalityIndicator');
  var loudnessBar         = document.getElementById('loudnessBar');
  var loudnessDisplay     = document.getElementById('loudnessDisplay');
  var loudnessFeedback    = document.getElementById('loudnessFeedback');
  var tonalityFeedback    = document.getElementById('tonalityFeedback');
  var pitchCanvas         = document.getElementById('pitchGraph');
  var pitchCtx            = pitchCanvas ? pitchCanvas.getContext('2d') : null;

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

  // === ZEITBASIERTER GLEITENDER MITTELWERT (Moving Average) – Zustand ===
  var VOLUME_WINDOW_MS  = 10000;   // 10 Sekunden für Lautstärke
  var PITCH_WINDOW_MS   = 10000;   // 10 Sekunden für Tonalität
  var volumeHistory     = [];      // Array von { value, ts }
  var pitchHistory      = [];      // Array von { value, ts }
  var lastVolumeFBTime  = 0;       // für träges Text-Feedback
  var lastToneFBTime    = 0;
  var FEEDBACK_INTERVAL = 500;     // Text-Feedback max. alle 500ms aktualisieren

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

  // >>> FÜLLWORT-ERKENNUNG <<<
  function normalizeWord(word) {
    var w = word.toLowerCase();
    var result = '';
    for (var j = 0; j < w.length; j++) {
      var c = w.charCodeAt(j);
      if (c === 228) { result += 'ae'; }
      else if (c === 246) { result += 'oe'; }
      else if (c === 252) { result += 'ue'; }
      else if (c === 223) { result += 'ss'; }
      else if (c === 196) { result += 'ae'; }
      else if (c === 214) { result += 'oe'; }
      else if (c === 220) { result += 'ue'; }
      else { result += w.charAt(j); }
    }
    return result;
  }

  function isFillerWord(word) {
    var w = normalizeWord(word);
    w = w.replace(/[.,!?;:()"'\u2014\u2013]/g, '').trim();
    if (w.length === 0) return false;
    if (FILLER_VARIANTS[w]) return true;
    if (w.length <= 4) {
      if (/^[aeuohm]+$/i.test(w)) return true;
    }
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

  // === ZEITBASIERTE HILFSFUNKTIONEN ===
  function pruneByAge(arr, windowMs, now) {
    var cutoff = now - windowMs;
    while (arr.length > 0 && arr[0].ts < cutoff) {
      arr.shift();
    }
  }

  function extractValues(arr) {
    var values = [];
    for (var i = 0; i < arr.length; i++) {
      values.push(arr[i].value);
    }
    return values;
  }

  function calcMovingAverage(arr) {
    if (arr.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i];
    }
    return sum / arr.length;
  }

  function removeOutliers(arr) {
    if (arr.length < 4) return arr;
    var sorted = arr.slice().sort(function(a, b) { return a - b; });
    var q1 = sorted[Math.floor(sorted.length * 0.25)];
    var q3 = sorted[Math.floor(sorted.length * 0.75)];
   var iqr = q3 - q1;
   var lower = q1 - 1.5 * iqr;
   var upper = q3 + 1.5 * iqr;
   return arr.filter(function(v) { return v >= lower && v <= upper; });
  }

  function calcStdDev(arr) {
    if (arr.length < 2) return 0;
    var avg = calcMovingAverage(arr);
    var variance = 0;
    for (var i = 0; i < arr.length; i++) {
      variance += Math.pow(arr[i] - avg, 2);
    }
    variance /= arr.length;
    return Math.sqrt(variance);
  }

  function updateLoudnessUI(rms) {
    var cls = classifyLoudness(rms);
    loudnessBar.style.width = cls.percent + '%';
    loudnessDisplay.textContent = cls.label;
    loudnessDisplay.className = 'metric-value small ' + cls.className;

    // === Text-Feedback für Lautstärke (träge aktualisiert) ===
    var now = Date.now();
    if (now - lastVolumeFBTime >= FEEDBACK_INTERVAL) {
      lastVolumeFBTime = now;
      var feedbackText, feedbackClass;
      if (rms < LOUDNESS_QUIET_MAX) {
        feedbackText  = 'Bitte lauter sprechen';
        feedbackClass = 'loudness-feedback-quiet';
      } else if (rms <= LOUDNESS_LOUD_MIN) {
        feedbackText  = 'Optimale Lautstärke';
        feedbackClass = 'loudness-feedback-normal';
      } else {
        feedbackText  = 'Bitte leiser sprechen';
        feedbackClass = 'loudness-feedback-loud';
      }
      loudnessFeedback.textContent = feedbackText;
      loudnessFeedback.className = 'feedback-text ' + feedbackClass;
    }
  }

  // ============================================================
  // === PAUSEN-ANALYSE ===
  // ============================================================
  function detectPause(rms, now) {
    if (rms < PAUSE_RMS_THRESHOLD) {
      if (!isInPause) {
        isInPause = true;
        pauseStartTime = now;
      }
      currentPauseDuration = (now - pauseStartTime) / 1000;
    } else {
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
    var rms = 0;
    for (var i = 0; i < buflen; i++) rms += timeDomainData[i] * timeDomainData[i];
    rms = Math.sqrt(rms / buflen);
    if (rms < 0.015) return 0;

    var maxOffset = Math.floor(sampleRate / 80);
    var minOffset = Math.floor(sampleRate / 400);
    var bestOffset = -1;
    var bestNSDF = -1;

    for (var offset = minOffset; offset <= maxOffset; offset++) {
      var num = 0, denom = 0;
      for (var i = 0; i < buflen - offset; i++) {
        num   += timeDomainData[i] * timeDomainData[i + offset];
        denom += timeDomainData[i] * timeDomainData[i] 
              + timeDomainData[i + offset] * timeDomainData[i + offset];
      }
      var nsdf = denom > 0 ? 2 * num / denom : 0;
      if (nsdf > bestNSDF) { bestNSDF = nsdf; bestOffset = offset; }
    }

    // Qualitätsschwelle: NSDF muss > 0.4 sein (0 = keine Korrelation, 1 = perfekt)
    if (bestOffset <= 0 || bestNSDF < 0.4) return 0;

    var pitch = sampleRate / bestOffset;
    if (pitch > 300 || pitch < 80) return 0;  // Menschliche Sprechstimme
    return pitch;
  }

  // Hilfsfunktion: Filtert Pitch-Werte ≤ 40 Hz (Pausen, Rauschen) heraus
  function filterValidPitchValues(arr) {
    var valid = [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] > 40) {
        valid.push(arr[i]);
      }
    }
    return valid;
  }

  function classifyTonalitySpan(stdDev) {
    if (stdDev < 6) {
      return { label: 'Monoton', className: 'tone-feedback-monotone' };
    } else if (stdDev <= 18) {
      return { label: 'Sehr gut und variabel', className: 'tone-feedback-varied' };
    } else {
      return { label: 'Etwas zu hektisch', className: 'tone-feedback-dynamic' };
    }
  }

  function drawPitchGraph() {
    if (!pitchCtx || !pitchCanvas) return;
    var ctx = pitchCtx;
    var w = pitchCanvas.width;
    var h = pitchCanvas.height;
    var values = extractValues(pitchHistory);

    ctx.clearRect(0, 0, w, h);

    // Hintergrund
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    if (values.length < 2) {
      // Platzhalter-Text
      ctx.fillStyle = '#4a5568';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Pitch-Kurve', w / 2, h / 2 + 4);
      return;
    }

    // Nur valide Werte für den dynamischen Bereich verwenden (> 40 Hz)
    var validValues = filterValidPitchValues(values);
    var minVal, maxVal;
    if (validValues.length >= 2) {
      minVal = validValues[0];
      maxVal = validValues[0];
      for (var i = 1; i < validValues.length; i++) {
        if (validValues[i] < minVal) minVal = validValues[i];
        if (validValues[i] > maxVal) maxVal = validValues[i];
      }
    } else {
      // Fallback, wenn keine validen Werte: Standardbereich 80-200 Hz
      minVal = 80;
      maxVal = 200;
    }
    var range = maxVal - minVal;
    if (range < 20) {
      // Mindestens 20 Hz Spanne für die visuelle Darstellung
      var mid = (maxVal + minVal) / 2;
      minVal = mid - 10;
      maxVal = mid + 10;
      range = 20;
    }
    if (range === 0) range = 20;

    // Gitterlinien
    ctx.strokeStyle = '#2d3748';
    ctx.lineWidth = 0.5;
    for (var y = 0; y < h; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Pitch-Kurve zeichnen (von rechts nach links – neueste Werte rechts)
    var maxPoints = w; // Maximal so viele Pixel wie Canvas breit
    var step = Math.max(1, Math.floor(values.length / maxPoints));
    var displayVals = [];
    for (var i = 0; i < values.length; i += step) {
      displayVals.push(values[i]);
    }
    // Sicherstellen, dass der letzte Wert enthalten ist
    if (displayVals[displayVals.length - 1] !== values[values.length - 1]) {
      displayVals.push(values[values.length - 1]);
    }

    ctx.strokeStyle = '#667eea';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    var pathStarted = false;

    for (var i = 0; i < displayVals.length; i++) {
      var val = displayVals[i];
      // Ungültige Werte (≤ 40 Hz) überspringen -> Linie unterbrechen
      if (val <= 40) {
        pathStarted = false;
        continue;
      }
      var x = (i / (displayVals.length - 1)) * w;
      var y = h - ((val - minVal) / range) * (h - 20) - 10;
      if (!pathStarted) {
        ctx.moveTo(x, y);
        pathStarted = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Aktuellen validen Wert (letzten) als Punkt hervorheben
    var lastValidVal = 0;
    var lastValidIdx = -1;
    for (var i = values.length - 1; i >= 0; i--) {
      if (values[i] > 40) {
        lastValidVal = values[i];
        lastValidIdx = i;
        break;
      }
    }
    if (lastValidIdx >= 0) {
      var lastX = w;
      var lastY = h - ((lastValidVal - minVal) / range) * (h - 20) - 10;
      ctx.fillStyle = '#e53e3e';
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Beschriftung: Min/Max Werte (basierend auf validen Werten)
    ctx.fillStyle = '#718096';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(minVal) + ' Hz', 4, h - 4);
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxVal) + ' Hz', w - 4, 12);
  }

  // Zustand für Delta-Limit (Sprung-Filter)
  var pitchEMA = 0;
  var EMA_ALPHA = 0.15;  // 0.1 = sehr träge, 0.3 = reaktiver

  function updateTonality(pitchHz, now) {
    // Delta-Limit: Maximal 15 Hz Änderung pro Frame vom letzten gültigen Wert
    if (pitchHz > 0) {
      if (pitchEMA === 0) {
        pitchEMA = pitchHz;  // Initialisierung
      } else {
        pitchEMA = EMA_ALPHA * pitchHz + (1 - EMA_ALPHA) * pitchEMA;
      }
      pitchHistory.push({ value: pitchEMA, ts: now });
    }

    // Alte Werte löschen (älter als PITCH_WINDOW_MS)
    pruneByAge(pitchHistory, PITCH_WINDOW_MS, now);
    if (pitchHistory.length < 1) {
      drawPitchGraph();
      return;
    }
    // Mindestens 3 Sekunden valide Sprachdaten nötig
    var oldestTs = pitchHistory[0].ts;
    if (now - oldestTs < 3000) {
      drawPitchGraph();
      return;
    }
    if (pitchHistory.length < 5) {
      tonalityDisplay.textContent = '—';
      tonalityIndicator.textContent = 'Unbekannt';
      tonalityIndicator.className = 'indicator';
      tonalityFeedback.textContent = '—';
      tonalityFeedback.className = 'feedback-text';
      drawPitchGraph();
      return;
    }

    var values = extractValues(pitchHistory);
    var validValues = filterValidPitchValues(values);

    // Wenn nach Filterung keine validen Werte übrig sind: Pause / Stille
    if (validValues.length < 2) {
      tonalityDisplay.textContent = '—';
      tonalityIndicator.textContent = 'Pause / Keine Sprache';
      tonalityIndicator.className = 'indicator';
      // Text-Feedback nicht überschreiben, bleibt auf letztem bekannten Zustand
      drawPitchGraph();
      return;
    }

    var smoothedAvg = calcMovingAverage(validValues);

    var CLASSIFY_WINDOW_MS = 4000;
    var recentHistory = pitchHistory.filter(function(p) {
    return p.ts >= now - CLASSIFY_WINDOW_MS;
    });

    var recentValues = filterValidPitchValues(extractValues(recentHistory));
    recentValues = removeOutliers(recentValues);  // ← NEU: Ausreißer entfernen
    if (recentValues.length < 5) {
      drawPitchGraph();
      return;
    }

    var stdDev = calcStdDev(recentValues);
    var fb = classifyTonalitySpan(stdDev);

    // Tonhöhe (geglättet) anzeigen
    tonalityDisplay.textContent = Math.round(smoothedAvg) + ' Hz';

    // === Text-Feedback basierend auf Standardabweichung der Trend-Linie ===
    if (now - lastToneFBTime >= FEEDBACK_INTERVAL) {
      lastToneFBTime = now;
      var fb = classifyTonalitySpan(stdDev);
      tonalityFeedback.textContent = fb.label;
      tonalityFeedback.className = 'feedback-text ' + fb.className;
    }

    // Bestehenden Indikator (Monoton/Steigend/Fallend/Variiert) beibehalten
    var label, className;
    if (stdDev < 6) {
      label = 'Monoton'; className = 'tone-monotone';
    } else {
      var half = Math.floor(validValues.length / 2);
      if (half < 2) { label = 'Variiert'; className = 'tone-varied'; }
      else {
        var first = validValues.slice(0, half);
        var second = validValues.slice(half);
        var avg1 = calcMovingAverage(first);
        var avg2 = calcMovingAverage(second);
        var diff = avg2 - avg1;
        if (diff > 20)            { label = 'Steigend'; className = 'tone-rising'; }
        else if (diff < -20)      { label = 'Fallend'; className = 'tone-falling'; }
        else                      { label = 'Variiert'; className = 'tone-varied'; }
      }
    }
    tonalityIndicator.textContent = label;
    tonalityIndicator.className = 'indicator ' + className;

    // Pitch-Graph zeichnen
    drawPitchGraph();
  }

  // ============================================================
  // === AUDIO-INFRASTRUKTUR – Analyse-Loop ===
  // ============================================================
  function initAudioContext(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.0;
    timeDomainData = new Float32Array(analyser.fftSize);
    var source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
  }

  function runAudioAnalysis() {
    if (!isRecording || !analyser) return;
    analyser.getFloatTimeDomainData(timeDomainData);
    var rms = calculateRMS(timeDomainData);
    var now = Date.now();

    // Pausen-Analyse
    detectPause(rms, now);
    updatePauseUI();

    // Tonalitäts-Analyse (zeitbasiert auf 20s)
    var pitch = estimatePitch(timeDomainData, audioContext.sampleRate);
    updateTonality(pitch, now);

    // Lautstärke-Analyse (zeitbasiert auf 10s)
    volumeHistory.push({ value: rms, ts: now });
    pruneByAge(volumeHistory, VOLUME_WINDOW_MS, now);
    var smoothedRMS = calcMovingAverage(extractValues(volumeHistory));
    updateLoudnessUI(smoothedRMS);

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
    
    pitchEMA = 0;
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

    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function(stream) {
        micStream = stream;
        initAudioContext(stream);
        runAudioAnalysis();

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
        console.warn('[SA] getUserMedia fehlgeschlagen:', err.name, err.message);
        if (err.name === 'NotAllowedError') {
          if (!window.isSecureContext) {
            micStatus.textContent = 'Bitte über localhost oder HTTPS öffnen (kein file://)';
          } else {
            micStatus.textContent = 'Mikrofon-Zugriff verweigert – Berechtigung in den Browser-Einstellungen erlauben';
          }
        } else if (err.name === 'NotFoundError') {
          micStatus.textContent = 'Kein Mikrofon gefunden';
        } else if (err.name === 'NotReadableError') {
          micStatus.textContent = 'Mikrofon wird von anderer App verwendet';
        } else {
          micStatus.textContent = 'Mikrofon-Zugriff verweigert';
        }
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
    pitchEMA = 0;

    wpmDisplay.textContent = '0';
    feedbackDisp.textContent = '\u2014';
    feedbackDisp.className = 'metric-value feedback';
    fillerCountEl.textContent = '0';
    fillerDensity.textContent = '0%';
    fillerWarning.classList.add('hidden');
    transcriptEl.textContent = '...';
    micStatus.textContent = 'Klicke zum Starten';

    // === NEUE UI-ELEMENTE ZURÜCKSETZEN ===
    volumeHistory = [];
    pitchHistory = [];
    lastVolumeFBTime = 0;
    lastToneFBTime = 0;
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
    tonalityFeedback.textContent = '—';
    tonalityFeedback.className = 'feedback-text';
    // Canvas leeren
    if (pitchCtx && pitchCanvas) {
      pitchCtx.clearRect(0, 0, pitchCanvas.width, pitchCanvas.height);
      pitchCtx.fillStyle = '#1a1a2e';
      pitchCtx.fillRect(0, 0, pitchCanvas.width, pitchCanvas.height);
      pitchCtx.fillStyle = '#4a5568';
      pitchCtx.font = '12px sans-serif';
      pitchCtx.textAlign = 'center';
      pitchCtx.fillText('Pitch-Kurve', pitchCanvas.width / 2, pitchCanvas.height / 2 + 4);
    }
    loudnessBar.style.width = '0%';
    loudnessDisplay.textContent = '—';
    loudnessDisplay.className = 'metric-value small';
    loudnessFeedback.textContent = '—';
    loudnessFeedback.className = 'feedback-text';
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

  // Secure-Context-Prüfung: getUserMedia & SpeechRecognition benötigen HTTPS oder localhost
  if (!window.isSecureContext) {
    micStatus.textContent = 'Bitte über localhost oder HTTPS öffnen (kein file://)';
    micButton.disabled = true;
  }

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micStatus.textContent = 'Bitte Chrome/Edge verwenden';
    micButton.disabled = true;
  }

  window.addEventListener('beforeunload', function() {
    if (isRecording && recognition) {
      try { recognition.abort(); } catch (_) {}
    }
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

  console.log('[SA] Speech Analyst v12 – Pitch-Glättung: Median-Filter + Delta-Limit 15 Hz + Cap 190 Hz');

})();
