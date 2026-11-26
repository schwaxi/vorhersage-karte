// vorhersage-karte v1.0.0
// Einzeln installierbares Modul (Home Assistant Marketplace / HACS, Kategorie Dashboard).
window.customCards = window.customCards || [];
// Eigener Block: Namen bleiben lokal, auch wenn mehrere Karten zusammen geladen werden.
{
// ---------------------------------------------------------------------------
// Vorhersage-Karte: Wettervorhersage als Liste, ein Tag pro Zeile (Symbol, Max/Min,
// Wind, Niederschlag bzw. Neuschnee). Jeder Tag laesst sich aufklappen und zeigt
// darunter die stuendlichen Werte. Gut lesbar am Handy.
//
//   type: custom:vorhersage-karte
//   entity: weather.forecast_home    # oder mehrere Orte:
//   entities:                         #   - entity: weather.forecast_home
//                                     #     name: Zuhause
//   titel: Vorhersage                 # optional
//   tage: 7                           # optional, Anzahl Tage
//   heute_offen: true                 # optional, heutigen Tag aufgeklappt zeigen
//   stunden_schritt: 1                # optional, 1 = jede Stunde, 3 = alle 3 Stunden
//   schnee: true                      # optional, bei Schnee Neuschnee in cm schaetzen (1 mm ~ 1 cm)
//   kopf: true                        # optional, aktuelles Wetter oben (nur erster Ort)
//   temperatur / luftfeuchte / luftdruck / wind_geschwindigkeit / wind_richtung: sensor.x
//                                     # optional, Werte fuer den Kopf aus eigener Wetterstation

const TYPE = "vorhersage-karte";
const WETTER = {
  "clear-night": ["mdi:weather-night", "Klar"], cloudy: ["mdi:weather-cloudy", "Bewölkt"], fog: ["mdi:weather-fog", "Nebel"],
  hail: ["mdi:weather-hail", "Hagel"], lightning: ["mdi:weather-lightning", "Gewitter"],
  "lightning-rainy": ["mdi:weather-lightning-rainy", "Gewitter mit Regen"], partlycloudy: ["mdi:weather-partly-cloudy", "Teilweise bewölkt"],
  pouring: ["mdi:weather-pouring", "Starkregen"], rainy: ["mdi:weather-rainy", "Regen"], snowy: ["mdi:weather-snowy", "Schnee"],
  "snowy-rainy": ["mdi:weather-snowy-rainy", "Schneeregen"], sunny: ["mdi:weather-sunny", "Sonnig"], windy: ["mdi:weather-windy", "Windig"],
  "windy-variant": ["mdi:weather-windy-variant", "Windig, bewölkt"], exceptional: ["mdi:alert-circle-outline", "Unwetter"],
};
const FARBE = {
  sunny: "#fdd835", partlycloudy: "#fdd835", "clear-night": "#b0bec5",
  rainy: "#4fc3f7", pouring: "#29b6f6", snowy: "#81d4fa", "snowy-rainy": "#81d4fa", hail: "#81d4fa",
  lightning: "#ffb300", "lightning-rainy": "#ffb300", exceptional: "#ef5350",
};
const RICHTUNG = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const WOCHENTAG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

const zahl = (v, st = 1) => Number(v).toLocaleString("de-DE", { maximumFractionDigits: st, minimumFractionDigits: 0 });
const tagKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

class VorhersageKarte extends HTMLElement {
  setConfig(c) {
    const liste = c?.entities || (c?.entity ? [c.entity] : []);
    const orte = (Array.isArray(liste) ? liste : [liste]).map((o) => (typeof o === "string" ? { entity: o } : o)).filter((o) => o?.entity);
    if (!orte.length) throw new Error("entity (weather.*) fehlt");
    for (const o of orte) if (!String(o.entity).startsWith("weather.")) throw new Error(`${o.entity} ist keine weather-Entität`);
    this._config = { tage: 7, heute_offen: true, stunden_schritt: 1, schnee: true, kopf: false, ...c };
    this._orte = orte;
    this._daten = orte.map(() => ({ daily: null, hourly: null, fehler: null }));
    this._offen = new Set(this._config.heute_offen ? ["0:0"] : []);
    this._abmelden();
    this._render();
    this._anmelden();
  }

  set hass(hass) {
    const erst = !this._hass;
    this._hass = hass;
    if (erst) { this._anmelden(); this._zeichnen(); }
    else this._kopf();
  }

  connectedCallback() { this._anmelden(); }
  disconnectedCallback() { this._abmelden(); }

  _anmelden() {
    if (this._abos || !this._hass?.connection || !this._config || !this.isConnected) return;
    this._abos = [];
    this._orte.forEach((o, i) => {
      const st = this._hass.states[o.entity];
      const sf = st?.attributes?.supported_features;
      for (const typ of ["daily", "hourly"]) {
        // supported_features: 1 = taeglich, 2 = stuendlich (unbekannt -> trotzdem versuchen)
        if (sf != null && !(sf & (typ === "daily" ? 1 : 2))) continue;
        this._abos.push(this._hass.connection.subscribeMessage((ev) => { this._daten[i][typ] = ev.forecast || []; this._zeichnen(); },
          { type: "weather/subscribe_forecast", forecast_type: typ, entity_id: o.entity })
          .catch((e) => { this._daten[i].fehler = String(e?.message || e); this._zeichnen(); }));
      }
    });
  }

  _abmelden() {
    const a = this._abos;
    this._abos = null;
    if (a) a.forEach((p) => p.then((ab) => ab && ab()).catch(() => {}));
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 4px 0 6px; overflow: hidden; }
        .titel { padding: 12px 16px 4px; font-size: 16px; font-weight: 500; color: var(--primary-text-color); }
        .kopf { display: none; padding: 12px 16px 8px; }
        .kopf.an { display: block; }
        .jetzt { display: flex; align-items: center; gap: 14px; }
        .jetzt ha-icon { --mdc-icon-size: 52px; }
        .jtemp { font-size: 36px; line-height: 1; color: var(--primary-text-color); }
        .jtemp small { font-size: 16px; color: var(--secondary-text-color); margin-left: 2px; }
        .jtext { font-size: 15px; color: var(--secondary-text-color); margin-top: 3px; }
        .jwerte { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; font-size: 14px; color: var(--primary-text-color); }
        .jwerte span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
        .jwerte ha-icon { --mdc-icon-size: 18px; color: var(--state-icon-color, #44739e); }
        .ort { padding: 12px 16px 2px; font-size: 15px; font-weight: 500; color: var(--primary-text-color); }
        .reihe {
          display: grid; grid-template-columns: minmax(84px, 1fr) 34px 46px 56px 72px 18px;
          column-gap: 3px; padding: 0 6px 0 14px; align-items: stretch;
        }
        .spalten { font-size: 11px; color: var(--secondary-text-color); letter-spacing: 0.3px; padding-top: 6px; padding-bottom: 4px; }
        .spalten > span { text-align: center; align-self: end; }
        .tag { min-height: 56px; border-top: 1px solid var(--divider-color); cursor: pointer; -webkit-tap-highlight-color: transparent; }
        .tag.ohne { cursor: default; }
        .c { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; line-height: 1.15; min-width: 0; }
        .name { align-items: flex-start; text-align: left; }
        .name b { font-size: 15px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .name small, .c small { font-size: 11px; color: var(--secondary-text-color); white-space: nowrap; }
        .sym ha-icon { --mdc-icon-size: 30px; }
        @media (min-width: 600px) {
          .reihe { grid-template-columns: minmax(110px, 1fr) 44px 64px 72px 84px 24px; column-gap: 6px; padding: 0 10px 0 16px; }
          .sym ha-icon { --mdc-icon-size: 34px; }
        }
        .temp b { font-size: 16px; font-weight: 500; color: var(--primary-text-color); }
        .temp small { font-size: 13px; }
        .wind b, .nied b { font-size: 15px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; }
        .wind small ha-icon { --mdc-icon-size: 11px; vertical-align: -1px; }
        .pfeil ha-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); transition: transform 0.2s; }
        .tag.offen .pfeil ha-icon { transform: rotate(180deg); }
        .stunden { display: none; background: rgba(127, 127, 127, 0.07); }
        .tag.offen + .stunden { display: block; }
        .std { min-height: 42px; border-top: 1px solid var(--divider-color); }
        .std .name b { font-size: 14px; font-weight: 400; }
        .std .sym ha-icon { --mdc-icon-size: 24px; }
        .std .temp b, .std .wind b, .std .nied b { font-size: 14px; }
        .meldung { padding: 16px; font-size: 13px; color: var(--secondary-text-color); text-align: center; }
        .hinweis { padding: 6px 16px 4px; font-size: 11px; color: var(--secondary-text-color); }
      </style>
      <ha-card>
        <div class="titel" hidden></div>
        <div class="kopf"></div>
        <div class="inhalt"></div>
      </ha-card>`;
    this.shadowRoot.querySelector(".inhalt").addEventListener("click", (ev) => {
      const t = ev.target.closest(".tag");
      if (!t || t.classList.contains("ohne")) return;
      const k = t.dataset.k;
      if (this._offen.has(k)) this._offen.delete(k); else this._offen.add(k);
      t.classList.toggle("offen", this._offen.has(k));
    });
    this._zeichnen();
  }

  _sensor(id) {
    const s = id && this._hass?.states[id];
    if (!s || isNaN(Number(s.state))) return null;
    return { v: Number(s.state), e: s.attributes.unit_of_measurement || "" };
  }

  _kopf() {
    const r = this.shadowRoot, c = this._config;
    if (!r || !c || !this._hass) return;
    const k = r.querySelector(".kopf");
    k.classList.toggle("an", !!c.kopf);
    if (!c.kopf) return;
    const w = this._hass.states[this._orte[0].entity];
    const [icon, text] = WETTER[w?.state] || ["mdi:weather-cloudy-alert", w?.state || "–"];
    const t = this._sensor(c.temperatur) || (w?.attributes.temperature != null ? { v: w.attributes.temperature, e: w.attributes.temperature_unit || "°C" } : null);
    const f = this._sensor(c.luftfeuchte) || (w?.attributes.humidity != null ? { v: w.attributes.humidity, e: "%" } : null);
    const p = this._sensor(c.luftdruck) || (w?.attributes.pressure != null ? { v: w.attributes.pressure, e: w.attributes.pressure_unit || "hPa" } : null);
    const ws = this._sensor(c.wind_geschwindigkeit) || (w?.attributes.wind_speed != null ? { v: w.attributes.wind_speed, e: w.attributes.wind_speed_unit || "km/h" } : null);
    const wr = this._sensor(c.wind_richtung) || (w?.attributes.wind_bearing != null ? { v: w.attributes.wind_bearing } : null);
    const werte = [];
    if (f) werte.push(["mdi:water-percent", `${zahl(f.v, 0)} %`]);
    if (p) werte.push(["mdi:gauge", `${zahl(p.v, 0)} ${p.e}`]);
    if (ws) werte.push(["mdi:weather-windy", `${zahl(ws.v, 0)} ${ws.e}${wr ? " " + RICHTUNG[Math.round(wr.v / 22.5) % 16] : ""}`]);
    const html = `
      <div class="jetzt"><ha-icon icon="${icon}" style="color:${FARBE[w?.state] || "var(--state-icon-color, #44739e)"}"></ha-icon>
        <div><div class="jtemp">${t ? zahl(t.v) : "–"}<small>${t ? t.e : ""}</small></div><div class="jtext">${esc(text)}</div></div></div>
      ${werte.length ? `<div class="jwerte">${werte.map(([i, v]) => `<span><ha-icon icon="${i}"></ha-icon>${esc(v)}</span>`).join("")}</div>` : ""}`;
    if (html !== this._kopfHtml) { k.innerHTML = html; this._kopfHtml = html; }
  }

  // Tage aus der taeglichen Vorhersage; fehlt sie, aus den Stundenwerten zusammenfassen
  _tage(d) {
    const heute = tagKey(new Date());
    const stunden = new Map();
    for (const h of d.hourly || []) {
      const dt = new Date(h.datetime);
      const k = tagKey(dt);
      if (!stunden.has(k)) stunden.set(k, []);
      stunden.get(k).push(h);
    }
    let tage = [];
    if (d.daily?.length) {
      tage = d.daily.map((x) => ({ ...x, _dt: new Date(x.datetime) }));
    } else {
      for (const [, hs] of stunden) {
        const temps = hs.map((h) => h.temperature).filter((v) => v != null);
        const mitte = hs[Math.floor(hs.length / 2)];
        tage.push({
          _dt: new Date(hs[0].datetime), condition: mitte.condition,
          temperature: Math.max(...temps), templow: Math.min(...temps),
          precipitation: hs.reduce((s, h) => s + (h.precipitation || 0), 0),
          wind_speed: Math.max(...hs.map((h) => h.wind_speed || 0)), wind_bearing: mitte.wind_bearing,
        });
      }
    }
    // vergangene Tage weg (manche Dienste liefern gestern noch mit)
    const jetzt = new Date(); jetzt.setHours(0, 0, 0, 0);
    tage = tage.filter((t) => t._dt >= jetzt || tagKey(t._dt) === heute).slice(0, Math.max(1, Number(this._config.tage) || 7));
    return tage.map((t) => ({ ...t, _stunden: stunden.get(tagKey(t._dt)) || [] }));
  }

  _symbol(cond, gross) {
    const [ic, text] = WETTER[cond] || ["mdi:weather-cloudy-alert", cond || ""];
    return `<div class="c sym" title="${esc(text)}"><ha-icon icon="${ic}" style="color:${FARBE[cond] || "var(--secondary-text-color)"}"></ha-icon></div>`;
  }

  _wind(x, stunde) {
    const v = x.wind_speed, g = x.wind_gust_speed;
    if (v == null) return `<div class="c wind"><b>–</b></div>`;
    const staerke = Math.min(1, Math.max(v, g || 0) / 60);
    const bg = `rgba(198, 70, 60, ${(0.08 + staerke * 0.55).toFixed(2)})`;
    const wert = g != null && g > v ? `${zahl(v, 0)}-${zahl(g, 0)}` : zahl(v, 0);
    const b = x.wind_bearing;
    const ri = b != null ? `<small><ha-icon icon="mdi:navigation" style="transform:rotate(${(Number(b) + 180) % 360}deg)"></ha-icon> ${RICHTUNG[Math.round(b / 22.5) % 16]}</small>` : "";
    return `<div class="c wind" style="background:${bg}"><b>${wert}</b>${ri}</div>`;
  }

  _niederschlag(x, stunde) {
    const p = Number(x.precipitation || 0), w = x.precipitation_probability;
    if (p < 0.05) return `<div class="c nied"><b>–</b>${w ? `<small>${zahl(w, 0)} %</small>` : ""}</div>`;
    const t = x.temperature;
    const schnee = this._config.schnee && (["snowy", "snowy-rainy"].includes(x.condition) || (t != null && t <= 0));
    const stark = Math.min(1, p / (stunde ? 3 : 15));
    const bg = `rgba(33, 150, 243, ${(0.15 + stark * 0.55).toFixed(2)})`;
    const st = p < 10 ? 1 : 0;
    const haupt = schnee ? `${zahl(p, st)} cm` : `${zahl(p, st)} mm`;
    const unter = schnee ? `${zahl(p, st)} mm${w ? ` · ${zahl(w, 0)} %` : ""}` : (w ? `${zahl(w, 0)} %` : "");
    return `<div class="c nied" style="background:${bg}" title="${schnee ? "Neuschnee geschätzt (1 mm ≈ 1 cm)" : "Niederschlag"}"><b>${schnee ? "≈ " : ""}${haupt}</b>${unter ? `<small>${unter}</small>` : ""}</div>`;
  }

  _tagName(dt, i) {
    const heute = new Date(); heute.setHours(0, 0, 0, 0);
    const d = new Date(dt); d.setHours(0, 0, 0, 0);
    const diff = Math.round((d - heute) / 86400000);
    const name = diff === 0 ? "Heute" : diff === 1 ? "Morgen" : WOCHENTAG[d.getDay()];
    return `<b>${name}</b><small>${d.getDate()}.${d.getMonth() + 1}.</small>`;
  }

  _zeichnen() {
    const r = this.shadowRoot, c = this._config;
    if (!r || !c) return;
    const ti = r.querySelector(".titel");
    ti.hidden = !c.titel;
    ti.textContent = c.titel || "";
    this._kopf();
    if (!this._hass) return;
    const schritt = Math.max(1, Number(c.stunden_schritt) || 1);
    const teile = this._orte.map((o, i) => {
      const d = this._daten[i];
      const name = o.name || (this._orte.length > 1 ? this._hass.states[o.entity]?.attributes.friendly_name || o.entity : "");
      const ortKopf = name ? `<div class="ort">${esc(name)}</div>` : "";
      if (!this._hass.states[o.entity]) return `${ortKopf}<div class="meldung">${esc(o.entity)} nicht gefunden</div>`;
      if (d.fehler && !d.daily && !d.hourly) return `${ortKopf}<div class="meldung">Keine Vorhersage: ${esc(d.fehler)}</div>`;
      if (!d.daily && !d.hourly) return `${ortKopf}<div class="meldung">Vorhersage wird geladen …</div>`;
      const tage = this._tage(d);
      if (!tage.length) return `${ortKopf}<div class="meldung">Keine Vorhersage verfügbar</div>`;
      const zeilen = tage.map((t, j) => {
        const k = `${i}:${j}`;
        const hs = t._stunden.filter((_, n) => n % schritt === 0);
        const offen = hs.length && this._offen.has(k);
        const tagZeile = `
          <div class="reihe tag${hs.length ? "" : " ohne"}${offen ? " offen" : ""}" data-k="${k}">
            <div class="c name">${this._tagName(t._dt, j)}</div>
            ${this._symbol(t.condition)}
            <div class="c temp"><b>${t.temperature != null ? zahl(t.temperature, 0) + "°" : "–"}</b>${t.templow != null ? `<small>${zahl(t.templow, 0)}°</small>` : ""}</div>
            ${this._wind(t, false)}
            ${this._niederschlag(t, false)}
            <div class="c pfeil">${hs.length ? `<ha-icon icon="mdi:chevron-down"></ha-icon>` : ""}</div>
          </div>`;
        const std = hs.length ? `<div class="stunden">${hs.map((h) => {
          const dt = new Date(h.datetime);
          return `
            <div class="reihe std">
              <div class="c name"><b>${String(dt.getHours()).padStart(2, "0")}:00</b></div>
              ${this._symbol(h.condition)}
              <div class="c temp"><b>${h.temperature != null ? zahl(h.temperature, 0) + "°" : "–"}</b></div>
              ${this._wind(h, true)}
              ${this._niederschlag(h, true)}
              <div></div>
            </div>`;
        }).join("")}</div>` : "";
        return tagZeile + std;
      }).join("");
      const ohne = tage.some((t) => !t._stunden.length) && tage.some((t) => t._stunden.length);
      return `${ortKopf}
        <div class="reihe spalten"><span></span><span></span><span>Max/Min</span><span>Wind km/h</span><span>Niederschl.</span><span></span></div>
        ${zeilen}
        ${ohne ? `<div class="hinweis">Stündliche Werte gibt es für die nächsten ${Math.round((d.hourly?.length || 0) / 24 * 10) / 10 || 2} Tage.</div>` : ""}`;
    });
    const html = teile.join("");
    if (html !== this._html) { r.querySelector(".inhalt").innerHTML = html; this._html = html; }
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "weather" } } },
        { name: "titel", selector: { text: {} } },
        { type: "grid", name: "", schema: [
          { name: "tage", selector: { number: { min: 1, max: 14, mode: "box" } } },
          { name: "stunden_schritt", selector: { select: { mode: "dropdown", options: [
            { value: 1, label: "Jede Stunde" }, { value: 2, label: "Alle 2 Stunden" }, { value: 3, label: "Alle 3 Stunden" }] } } },
        ] },
        { type: "grid", name: "", schema: [
          { name: "heute_offen", selector: { boolean: {} } },
          { name: "schnee", selector: { boolean: {} } },
          { name: "kopf", selector: { boolean: {} } },
        ] },
      ],
      computeLabel: (s) => ({
        entity: "Wetter-Entität", titel: "Titel (optional)", tage: "Anzahl Tage", stunden_schritt: "Stundenwerte",
        heute_offen: "Heute aufgeklappt", schnee: "Neuschnee in cm schätzen", kopf: "Aktuelles Wetter oben",
      }[s.name]),
    };
  }

  static getStubConfig(hass) {
    const e = Object.keys(hass?.states ?? {}).find((id) => id.startsWith("weather.")) ?? "weather.forecast_home";
    return { entity: e };
  }
}

if (!customElements.get(TYPE)) customElements.define(TYPE, VorhersageKarte);
if (!window.customCards.some((c) => c.type === TYPE)) {
  window.customCards.push({ type: TYPE, name: "Vorhersage-Karte", description: "Wettervorhersage als Tagesliste, jeder Tag aufklappbar mit Stundenwerten", preview: true });
}
}

console.info("%c vorhersage-karte %c v1.0.0 ", "color:#fff;background:#03a9f4;font-weight:700", "color:#03a9f4");
