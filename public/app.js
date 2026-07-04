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

    try {
      recognition.start();
      console.log('[SA] start() aufgerufen');
    } catch (e) {
      console.warn('[SA] start() fehlgeschlagen:', e.message);
      recognition = null;
      micStatus.textContent = 'Start fehlgeschlagen';
      isRecording = false;
    }
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
  });

  console.log('[SA] Speech Analyst v9 – Unicode-Normalisierung für Füllwörter');

})();