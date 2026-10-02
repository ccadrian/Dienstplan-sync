// Erzeugt ein Beispielfoto eines Wochendienstplans (tests/fixtures/dienstplan.png).
// Hochauflösend (ca. 3100 x 4400 px), damit die PWA das Verkleinern beweisen muss.
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const rows = [
  ["Mo 05.10.", "07:15", "Antreten, Befehlsausgabe", "Kp-Block", "KpFw", "Feldanzug", ""],
  ["", "07:30", "Waffenausbildung G36", "Hörsaal 2", "OLt Berger", "Feldanzug", "Waffe empfangen"],
  ["", "12:00 – 13:00", "Mittagessen", "Truppenküche", "", "", ""],
  ["", "13:00", "Sport (Ausdauer)", "Sportplatz", "StUffz Kaya", "Sportanzug", "Wasser mitnehmen"],
  ["", "16:30", "Dienstschluss", "", "", "", ""],
  ["Di 06.10.", "07:15", "Antreten", "Kp-Block", "KpFw", "Feldanzug", ""],
  ["", "07:30 – 15:30", "Schießen G36 (Übung 3)", "StOÜbPl Schießbahn 4", "Hptm Wolf", "Feldanzug, Gefechtshelm", "Gehörschutz!"],
  ["Mi 07.10.", "ganztägig", "GvD", "Wache Nord", "", "Dienstanzug", "Ablösung 07:00"],
  ["Do 08.10.", "07:15", "Antreten", "Kp-Block", "KpFw", "Feldanzug", ""],
  ["", "08:00 – 11:30", "Sanitätsausbildung (EH)", "Hörsaal 1", "OFw Schulz", "Feldanzug", ""],
  ["", "13:00", "Technischer Dienst Kfz", "Fahrzeughalle", "Fw Lang", "Arbeitsanzug", ""],
  ["Fr 09.10.", "ganztägig", "Dienstfrei (Gleittag)", "", "", "", ""],
];

const html = `<!doctype html><html><head><style>
  body { margin:0; background:#d8d4cc; font-family: Arial, sans-serif; }
  .paper { width: 1180px; margin: 30px; padding: 40px 46px; background:#fbfaf6; box-shadow: 0 8px 30px rgba(0,0,0,.35); transform: rotate(-0.8deg); }
  h1 { margin:0 0 4px; font-size: 30px; letter-spacing:.02em }
  .meta { display:flex; justify-content:space-between; font-size:18px; margin-bottom:18px }
  table { width:100%; border-collapse: collapse; font-size: 17px }
  th, td { border:1.5px solid #333; padding:7px 8px; vertical-align: top; text-align:left }
  th { background:#e6e3da }
  .foot { margin-top:18px; font-size:15px; color:#333 }
</style></head><body><div class="paper">
  <h1>Wochendienstplan 2. Kompanie</h1>
  <div class="meta"><span>KW 41 / 2026 &nbsp;(05.10. – 09.10.2026)</span><span>Stand: 01.10.2026</span></div>
  <table><thead><tr><th>Tag</th><th>Uhrzeit</th><th>Ausbildung / Tätigkeit</th><th>Ort</th><th>Leitender</th><th>Anzug</th><th>Bemerkungen</th></tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>
  <div class="foot">gez. Hauptmann Wolf, Kompaniechef</div>
</div></body></html>`;

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1240, height: 1100 }, deviceScaleFactor: 2.5 });
await page.setContent(html);
const out = fileURLToPath(new URL("./dienstplan.png", import.meta.url));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log("geschrieben:", out);
