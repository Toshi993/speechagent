# Speech Analyst

Echtzeit-Sprachanalyse für Sprechtempo (WPM) und Füllwörter – direkt im Browser.

## Features

- **WPM-Tracking**: Zeigt live die gesprochenen Wörter pro Minute an.
- **Live-Feedback**: Textuelles Feedback basierend auf WPM:
  - < 110 WPM → "Schneller reden"
  - 110–150 WPM → "Gut so"
  - > 150 WPM → "Langsamer reden"
- **Füllwort-Zähler**: Erkennt Füllwörter wie "äh", "ähm", "also", "quasi" u. a. und warnt bei hoher Dichte.
- **Transkript**: Laufende Spracherkennung mit Echtzeit-Transkription.
- **Minimalistisches UI**: Sauberes, responsives Design.

## Voraussetzungen

- **Browser**: Google Chrome oder Microsoft Edge (die Web Speech API ist nur in Chromium-Browsern verfügbar).
- **Mikrofon**: Zugriff auf ein Mikrofon ist erforderlich.

## Verwendung

1. Lade die App entweder direkt über `file://` oder besser über einen lokalen HTTP-Server:
   ```bash
   python -m http.server 8000
   ```
2. Öffne `http://localhost:8000` im Browser.
3. Klicke auf den Mikrofon-Button, um die Aufnahme zu starten.
4. Sprich ins Mikrofon – WPM, Feedback und Füllwörter werden live aktualisiert.
5. Klicke erneut auf den Mikrofon-Button, um die Aufnahme zu stoppen.
6. Mit "Zurücksetzen" beginnst du eine neue Session.

## Technologie

- **Web Speech API (SpeechRecognition)**: Spracherkennung und Transkription.
- **HTML5 / CSS3 / Vanilla JavaScript**: Kein Framework, keine Abhängigkeiten.

## Projektstruktur

```
01_Speech Analyst/
├── index.html    UI-Struktur
├── styles.css    Styling
├── app.js        Anwendungslogik
└── README.md     Diese Datei
```

## Lizenz

MIT