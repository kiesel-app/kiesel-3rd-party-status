# Kiesel · Status der Drittanbieter

Täglicher Health-Check der externen Endpunkte, auf die [Kiesel](https://kiesel.app)
angewiesen ist. Ergebnis als Seite zum Bookmarken:

**https://kiesel-app.github.io/kiesel-3rd-party-status/**

## Warum

Kiesel ist ein Client, kein Anbieter — Embeds, Feeds und Anmeldungen hängen an
fremden Diensten. Ändert einer davon still sein Antwortformat oder sperrt einen
Pfad, merkt man das sonst erst am Bug-Report eines Nutzers. Der Check läuft
täglich um 06:15 UTC und macht solche Änderungen sichtbar, bevor sie gemeldet
werden.

## Was geprüft wird

| Gruppe | Inhalt |
|---|---|
| oEmbed-Provider | YouTube, Vimeo, TikTok, Spotify, SoundCloud, Dailymotion, Apple Podcasts |
| Embeds ohne oEmbed | ZDF, ARD Audiothek, Twitch, Overcast, Pocket Casts |
| Protokoll-APIs | Bluesky AppView, bsky.social, mastodon.social, Wikidata |
| Feed-Quellen | YouTube-RSS für Kanäle und Playlists, channel_id im Kanal-HTML |
| Kiesel-eigen | `client-metadata.json` (OAuth), Website |

Bei den Anbietern ohne oEmbed wird nicht bloß die Erreichbarkeit geprüft,
sondern **das Muster, an dem der Code hängt** — etwa das JSON-LD-`VideoObject`
bei ZDF. Eine Seite, die antwortet, aber ihr Markup umgebaut hat, ist für Kiesel
genauso kaputt wie eine, die nicht antwortet.

## Die drei Zustände

- **OK** — Endpunkt antwortet, Erwartung erfüllt.
- **Beispiel veraltet** — der Dienst läuft, aber die hier hinterlegte
  Beispiel-URL existiert nicht mehr (etwa ein gelöschtes Video). Unsere
  Baustelle, kein Ausfall. Dann in `checks.json` ein neues `sample` eintragen.
- **Ausfall** — nicht erreichbar, gesperrt, oder das Antwortformat hat sich
  geändert.

Diese Trennung ist Absicht: Würde ein gelöschtes Beispielvideo als roter
Anbieter erscheinen, gewöhnte sich jeder daran, die Seite zu ignorieren.

## Einen Endpunkt ergänzen

`checks.json` bearbeiten — ein Eintrag, kein Code. Vier Typen:

```jsonc
{ "type": "oembed",  "endpoint": "…/oembed", "sample": "https://…" }  // holt sample über endpoint, erwartet html/title
{ "type": "json",    "url": "https://…", "expectField": "did" }       // erwartet ein Feld in der JSON-Antwort
{ "type": "pattern", "url": "https://…", "pattern": "regex" }         // erwartet ein Muster in der Antwort
{ "type": "http",    "url": "https://…" }                             // erwartet nur 2xx
```

Optional `note` ergänzen: ein Satz dazu, was in Kiesel bricht, wenn dieser
Check rot wird. Der steht dann auf der Statusseite — hilfreich für alle, die
nicht im Kopf haben, wofür ein Endpunkt gebraucht wird.

## Lokal ausführen

```sh
node scripts/health-check.mjs
```

Schreibt `public/index.html`, `public/status.json` und `public/history.json`.
Node 20+, keine Abhängigkeiten. Exit-Code 1, sobald ein Check ausfällt.

## Einmalige Einrichtung

Unter *Settings → Pages* als Quelle **GitHub Actions** wählen. Der Workflow
committet `public/` zurück nach `main` (damit der Verlauf erhalten bleibt) und
veröffentlicht sie als Pages-Artefakt.
