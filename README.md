# FamilienPlan für ioBroker

Der Adapter importiert Kalenderdaten aus der REST-API einer FamilienPlan-Installation. Er erzeugt dynamische, für Blockly und JavaScript nutzbare Objekte, Tagesübersichten, Geburtstags- und Abfalltexte sowie persistente Trigger.

## Installation und Einrichtung

Der Adapter benötigt Node.js 20 oder neuer, js-controller 6.0.11 und Admin 7.0.23. Für die lokale Entwicklung im Adapterverzeichnis `npm install` und `npm run build` ausführen. Eine lokale Installation kann anschließend über die ioBroker-Admin-Oberfläche erfolgen.

In FamilienPlan bei der Person, deren Berechtigungen verwendet werden sollen, einen Integrations-API-Schlüssel erzeugen. In der Adapterkonfiguration die Basisadresse (zum Beispiel `https://familienplan.example`) und den Schlüssel eintragen. Der Schlüssel wird als geschützter `protectedNative`-Wert und Passwortfeld behandelt. Danach „Verbindung testen“, speichern und die Instanz starten.

Die JSON Config umfasst:

- Verbindung: URL, geschützter Schlüssel, Verbindungstest, IANA-Zeitzone, Timeout und Zertifikatsprüfung.
- Abruf: Woche, Monat, Quartal oder Jahr mit zusätzlichen Tagen davor und danach, Intervall, Retry/Backoff, optionale Kind-IDs, Standorte und Objektaufbewahrung. Große Bereiche werden API-konform in Teilabfragen zerlegt.
- Timeline: Tage, Typfilter, Textvorlage `{title}`, `{time}`, `{date}`, `{type}`, Trennzeichen und Formate.
- Geburtstage und Abfall: relative Vorlagen, Trennzeichen, Leertext und Titelzuordnung. Alle von der API gelieferten Abfallarten werden übernommen. Beide verwenden den vollständig konfigurierten API-Abrufbereich und benötigen kein separates Vorschautageslimit.
- Trigger: beliebig viele Regeln, deren Name zugleich die stabile Objekt-ID bildet, mit Terminart, optionaler eigener Terminart, Kindname, Position, Offset/Einheit und Nachholfenster.

Wird die SSL-Prüfung abgeschaltet, schreibt der Adapter ausdrücklich eine Sicherheitswarnung. Das sollte nur vorübergehend bei einer kontrollierten lokalen Installation geschehen.

## API

Verwendet werden ausschließlich Bearer-Header, nie URL-Parameter für den Schlüssel:

- `GET /api/v1/integrations/v1/status`
- `GET /api/v1/integrations/v1/children`
- `GET /api/v1/integrations/v1/calendar?from_at=…&to_at=…[&child_id=…]`
- `GET /api/v1/integrations/v1/children/{id}/location`

Manueller Test:

```bash
curl -H "Authorization: Bearer <API-SCHLÜSSEL>" \
  "https://familienplan.example/api/v1/integrations/v1/calendar?from_at=2026-09-05T00%3A00%3A00%2B02%3A00&to_at=2026-09-06T00%3A00%3A00%2B02%3A00"
```

## Objekte

```text
familyplan.0
├── info                 Verbindung, Abrufe, API-Version, Bereich und Zähler
├── control.refresh      beschreibbarer Aktualisierungstaster
├── calendar             unveränderte gültige API-Ereignisse und current
├── children.<name>      dynamisch erkannte Kinder, z. B. children.rika
├── appointments          gemeinsame stabile Terminübersicht
├── events.appointment    dynamisch erkannte event_type-Gruppen
├── timeline             today, tomorrow, days_2 …
├── birthdays            relative Geburtstagsgruppen
├── waste                relative Abfallgruppen
└── triggers             Regelzustände, Plan und persistente Historie
```

Seit FamilienPlan API 0.1.82 enthalten Kalenderobjekte ausschließlich `event_type`; das frühere Feld `type` wird nicht ausgewertet. Unterstützt werden insbesondere `GENERAL`, `STAY`, `SCHOOL`, `SCHOOL_HOLIDAY`, `BIRTHDAY`, `PRIVATE`, `WASTE`, `CLEANING` und `OTHER`. Weitere von der API gelieferte Werte werden dynamisch unterstützt. `OTHER` wird zusätzlich nach dem normalisierten `custom_type_label` aufgeteilt, etwa `events.appointment.other.elternabend`; ohne Label wird `unknown` verwendet.

Jeder Typordner besitzt Zusammenfassungen, Monatsgruppen sowie `next` und `nextAfter`. `next` berücksichtigt ausschließlich noch nicht begonnene Termine; laufende oder vergangene Ereignisse werden dort nicht angezeigt. Flüchtige Ereignis-IDs werden nicht als Objektpfade verwendet. `active` ist genau von einschließlich `starts_at` bis ausschließlich `ends_at` wahr; aggregierte Daten werden beim nächsten Auswertungslauf ersetzt oder entfernt.

`calendar.current` fasst alle gerade aktiven Ereignisse in `json`, `eventIds` und `count` zusammen. `active` zeigt an, ob überhaupt ein Ereignis läuft. Der monotone Datenpunkt `revision` erhöht sich nur, wenn ein Ereignis aktiv wird oder endet, und eignet sich deshalb besonders als externer Trigger.

## Timeline, Geburtstage und Abfall

Die Timeline ordnet Ereignisse kalendarisch in der konfigurierten Zeitzone zu. Mehrtägige Einträge erscheinen an jedem berührten Tag; `startsThisDay`, `endsThisDay` und `continuesThisDay` beschreiben die Lage. Sommer-/Winterzeit wird durch IANA-Zeitzonen berücksichtigt.

Geburtstage werden gruppiert und behalten das API-Alter. Fehlt `birth_date`, wird es dokumentiert ableitbar als Tag/Monat von `starts_at` und `Jahr(starts_at) - age` ausgegeben. Dies ist eine Anzeigeableitung, kein zusätzlich von der API bestätigtes Datum.

Abfall verwendet `event_type=WASTE`. Die Abfallart wird aus dem Titelteil vor „in“, „am“ oder „für“ abgeleitet; der Originaltitel bleibt erhalten. Konfigurierte Teiltext-Zuordnungen haben Vorrang.

Betreuungen verwenden `event_type=STAY`. Explizite Betreuungen besitzen eine ID und `source=stay`. Aus „Wohnt bei“ erzeugte Standardbetreuungen besitzen `id=null`, `source=default` und `generated=true`. Für solche Einträge bildet der Adapter stabile interne Schlüssel aus Kind, verantwortlicher Person, Beginn, Ende und Quelle. Identische angrenzende Standardintervalle, die nur durch Teilabfragen entstanden sind, werden wieder zusammengeführt; explizite und generierte Einträge werden nicht gleichgesetzt.

## Zuverlässige Trigger

Positionen sind `beforeStart`, `afterStart`, `beforeEnd`, `afterEnd`; Offset-Einheiten sind Sekunden, Minuten, Stunden oder Tage. Regeln filtern direkt nach `event_type`; `custom_type_label` wird nur bei `OTHER` berücksichtigt. Der Regelname wird normalisiert als ioBroker-Objekt-ID verwendet. Die Impuls-/Nachholzeit bestimmt sowohl die Einschaltdauer von `active` als auch das Fenster, in dem eine verspätete Prüfung nachgeholt werden darf. Eine persistente SHA-256-Kennung aus Regel, `event_type`, Ereignisschlüssel, Start/Ende, Position und Offset verhindert Doppelungen nach Neustarts. Für generierte `STAY`-Einträge funktioniert dies auch bei `id=null`.

Automatisierungen reagieren zuverlässig auf den monotonen Zähler `triggers.<regel-id>.count`. `event` enthält die vollständige Nutzlast; `lastTriggered`, `lastEventId` und `scheduledFor` liefern Kontext. Der Admin-Tab zeigt Verbindungswerte, Filter, chronologische Ereignisse und geplante beziehungsweise bereits fällige Trigger.

### JavaScript-Beispiel

```javascript
on({ id: 'familyplan.0.triggers.waste_before_start_1d.count', change: 'ne' }, obj => {
    const payload = JSON.parse(getState('familyplan.0.triggers.waste_before_start_1d.event').val);
    sendTo('telegram.0', 'send', { text: payload.event.title + ' wird morgen abgeholt.' });
});
```

### Blockly

Einen Block „Falls Objekt geändert“ für `familyplan.0.triggers.<regel-id>.count` mit Änderungstyp „ungleich letzter Wert“ verwenden. Im Zweig kann `event` als JSON gelesen oder `lastEventId` genutzt werden. Für eine manuelle Aktualisierung `control.refresh` unbestätigt auf `true` setzen.

## Fehlerbehebung und Sicherheit

- **401:** Schlüssel fehlt, ist falsch oder wurde widerrufen.
- **403:** Die zum Schlüssel gehörende Person besitzt nicht alle benötigten Leserechte.
- **422:** Bereich, Zeitzone oder Filter prüfen. Der Adapter zerlegt große konfigurierte Bereiche automatisch in kleinere API-Abfragen.
- **429/5xx:** Der Adapter wiederholt begrenzt mit exponentiellem Backoff und behält vorhandene Daten.
- **Timeout/DNS:** Erreichbarkeit, Basis-URL, DNS und konfiguriertes Timeout prüfen.
- **TLS:** Zertifikatskette korrigieren. Die Prüfung nur in kontrollierten Testumgebungen deaktivieren.

Der API-Schlüssel wird verschlüsselt gespeichert, durch `protectedNative` geschützt und zusammen mit dem Authorization-Header weder protokolliert noch unmaskiert in Fehlertexten ausgegeben. Einzelne ungültige Ereignisse werden übersprungen; unbekannte Typen und zusätzliche Felder bleiben unterstützt. Für Entwicklung und Support niemals Konfigurationen oder Diagnoseausgaben mit einem echten Schlüssel veröffentlichen.

## Entwicklung

`npm run validate` führt TypeScript-Prüfung, ESLint, Unit-/Pakettests und Build aus. HTTP-Tests verwenden ausschließlich Mocks und benötigen keine FamilienPlan-Installation.

Der lokale ioBroker Dev-Server wird mit `npm run dev-server watch` gestartet. Die Admin-Oberfläche ist anschließend standardmäßig unter `http://127.0.0.1:8081` erreichbar. Das initiale Profil wird mit `npm run dev-server setup` angelegt; `.dev-server/` enthält ausschließlich lokale Testdaten und wird nicht paketiert.

## Changelog

### Unreleased

- Kompatibilität mit FamilienPlan API 0.1.82: Kalender, Kinder und Location ohne `type`.
- Sämtliche Kalenderlogik auf `event_type` umgestellt.
- Generierte Standardbetreuungen mit `id=null` werden stabil identifiziert und über Abfragegrenzen zusammengeführt.
- Trigger, Admin-Tab, Parser, Filter und Objekterzeugung an das neue Modell angepasst.

### 0.1.0 (2026-09-03)

- Erste vollständige Implementierung.
