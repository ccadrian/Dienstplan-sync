# Dienstplan Sync ohne eigene App (Claude-App + Google-Kalender-Connector)

Kosten: nichts zusätzlich zum Claude-Abo. Kein Google-Cloud-Projekt, kein API Key.

## Einmalig einrichten

1. **Kalender anlegen:** In Google Kalender (Web) unter „Weitere Kalender → +“ einen Kalender **„Dienst“** anlegen, Zeitzone Europe/Berlin.
2. **Connector verbinden:** In Claude unter **Einstellungen → Connectors** „Google Calendar“ verbinden.
3. **Projekt anlegen:** In Claude ein Projekt **„Dienstplan“** anlegen und den Text unten in die **Projekt-Anweisungen** kopieren.

## Benutzen

Im Projekt einen neuen Chat öffnen, das Foto vom Dienstplan schicken, fertig. Der Text „eintragen“ dazu reicht.

## Projekt-Anweisungen (kopieren)

```
Ich schicke dir Fotos von meinem Dienstplan (Wochendienstplan Bundeswehr).
Trage alle Termine ohne Rückfrage über den Google-Kalender-Connector in meinen
Kalender "Dienst" ein. Zeitzone Europe/Berlin.

Pro Eintrag lesen: Datum, Beginn, Ende, Titel, Ort, Verantwortlicher, Anzug,
Hinweise, ganztägig ja/nein, und wie sicher du dir bist.

Regeln:
- Nichts erfinden. Durchgestrichenes weglassen, handschriftliche Änderungen
  haben Vorrang.
- Fehlt die Endzeit: Beginn des nächsten Eintrags am selben Tag; beim letzten
  Eintrag des Tages der Dienstschluss, sonst 1 Stunde.
- Ganztägig als Ganztagstermin: Urlaub, Dienstfrei, Wache, GvD, UvD, Krank,
  ganztägige Lehrgänge. Mehrtägiges als ein Termin pro Tag.
- Jahr und Kalenderwoche aus dem Plan ableiten; stehen nur Wochentage dort,
  Datum aus KW und Wochentag berechnen. Sonst das heutige Datum als Bezug.
- "täglich ..." für jeden betroffenen Tag einzeln eintragen.
- Ort ins Ortsfeld. Beschreibung: "Verantwortlich: ...", "Anzug: ...",
  "Hinweise: ..." (nur vorhandene Zeilen).
- Erinnerung: 30 Minuten vorher; bei Ganztagsterminen am Vorabend 19:00
  (300 Minuten vor Beginn).
- Bist du bei Datum, Uhrzeit oder Titel unsicher: trotzdem eintragen, aber den
  Titel mit "[?] " beginnen.
- Keine Duplikate: Suche vorher im Kalender "Dienst" nach Terminen im
  Zeitraum des Plans, deren Beschreibung "Quelle: Dienstplan KW <Nr>/<Jahr>"
  enthält, und lösche sie. Schreibe diese Zeile ans Ende jeder neuen Beschreibung.
- Ist das Foto nicht lesbar, sag kurz warum und trage nichts ein.

Antworte am Ende nur kurz: "<Anzahl> Termine eingetragen (KW <Nr>)" und eine
knappe Liste nach Tagen, unsichere Einträge markiert.
```

## Hinweise

- Ob Kalender-Auswahl, Erinnerungen und Löschen klappen, hängt davon ab, was der
  Connector gerade kann. Sagt Claude, dass etwas nicht geht (z.B. Erinnerungen),
  stell im Kalender „Dienst“ unter **Einstellungen → Standardbenachrichtigungen**
  30 Minuten bzw. für ganztägige Termine „Am Vortag um 19:00“ ein.
- Der restliche Code in diesem Repo (eigene App) wird dafür nicht gebraucht.
