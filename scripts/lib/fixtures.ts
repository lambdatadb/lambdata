import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";

export function fieldNotesSqlite(dir: string): string {
  const path = join(dir, "field-notes.sqlite");
  rmSync(path, { force: true });
  const db = new Database(path);
  db.run("CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, region TEXT NOT NULL, elevation_m INTEGER)");
  db.run(
    "CREATE TABLE observations (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id), observed_on DATE NOT NULL, species TEXT NOT NULL, count INTEGER NOT NULL, notes TEXT)",
  );
  db.run("CREATE INDEX idx_observations_site ON observations(site_id)");
  const sites: [string, string, number][] = [
    ["Alder Ridge", "North", 412],
    ["Birch Hollow", "North", 188],
    ["Cedar Point", "Coast", 12],
    ["Dune Flats", "Coast", 4],
    ["Elk Meadow", "Highlands", 1290],
    ["Fern Gully", "Highlands", 860],
  ];
  const addSite = db.prepare("INSERT INTO sites (name, region, elevation_m) VALUES (?, ?, ?)");
  for (const site of sites) addSite.run(...site);
  const species = ["Barn swallow", "Great tit", "Common buzzard", "Grey heron", "Red kite", "Wren", "Goldcrest", "Kingfisher"];
  const addObservation = db.prepare("INSERT INTO observations (site_id, observed_on, species, count, notes) VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 480; i++) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 43_200_000).toISOString().slice(0, 10);
    addObservation.run((i % 6) + 1, day, species[i % species.length]!, 1 + ((i * 7) % 13), i % 9 === 0 ? "Seen near the water" : null);
  }
  db.close();
  return path;
}

export function legacyCrmSqlite(dir: string): string {
  const path = join(dir, "legacy-crm.sqlite");
  rmSync(path, { force: true });
  const db = new Database(path);
  db.run("CREATE TABLE contacts (handle TEXT NOT NULL UNIQUE, full_name TEXT, phone)");
  db.run("CREATE TABLE deals (id INTEGER PRIMARY KEY, contact_handle TEXT REFERENCES contacts(handle), amount, stage TEXT, closed_on DATETIME)");
  db.run("CREATE TABLE settings (key TEXT NOT NULL PRIMARY KEY, value TEXT)");
  db.run("CREATE VIEW open_deals AS SELECT * FROM deals WHERE stage <> 'won'");
  db.run("CREATE TRIGGER touch_deal AFTER UPDATE ON deals BEGIN SELECT 1; END");
  const contact = db.prepare("INSERT INTO contacts VALUES (?, ?, ?)");
  const people: [string, string, string | number][] = [
    ["nadia.k", "Nadia Kowalski", "+44 20 7946 0101"],
    ["Nadia.K", "Nadia Kowalska", 442079460102],
    ["oliver.b", "Oliver Bennett", "+44 20 7946 0103"],
    ["oliver.b ", "Oliver Bennett (old)", "+44 20 7946 0104"],
    ["sofia.r", "Sofia Rossi", 390612345678],
  ];
  for (const p of people) contact.run(...p);
  const deal = db.prepare("INSERT INTO deals (contact_handle, amount, stage, closed_on) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 40; i++) {
    deal.run(people[i % people.length]![0], i % 6 === 0 ? "1200.50" : 800 + i * 95, ["lead", "proposal", "won", "lost"][i % 4]!, i % 7 === 0 ? "soon" : `2026-0${(i % 9) + 1}-15 10:00:00`);
  }
  deal.run("someone.else", 99, "lead", null);
  const setting = db.prepare("INSERT INTO settings VALUES (?, ?)");
  for (let i = 0; i < 12; i++) setting.run(`ui.panel.${i}`, i % 3 === 0 ? "" : String(i));
  db.close();
  return path;
}
