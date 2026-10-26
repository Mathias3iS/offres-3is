/**
 * Génère offres.json à partir de la base Notion « Offres alternance, CDD et stages ».
 *
 * Lancé chaque matin par .github/workflows/offres.yml.
 * Node 18 ou plus. Aucune dépendance : fetch est natif.
 *
 * Variables d'environnement attendues :
 *   NOTION_TOKEN  — jeton d'intégration interne Notion (secret GitHub)
 *   NOTION_DB     — identifiant de la base (facultatif, valeur par défaut ci-dessous)
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const TOKEN = process.env.NOTION_TOKEN;
const DB = process.env.NOTION_DB || "96636fcbaa3447d4b6ca3ac29831966e";
const API = process.env.NOTION_API || "https://api.notion.com";
const SORTIE = process.env.SORTIE || "offres.json";

if (!TOKEN) {
  console.error("NOTION_TOKEN manquant. Ajoute-le dans les secrets du dépôt GitHub.");
  process.exit(1);
}

/* ─── Lecture de la base Notion ─────────────────────────────────────────── */

async function appel(url, version, corps) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(corps),
  });
  const d = await r.json();
  if (!r.ok) {
    const e = new Error(`${r.status} ${d.code || ""} ${d.message || ""}`.trim());
    e.statut = r.status;
    throw e;
  }
  return d;
}

/**
 * Interroge la base. Essaie d'abord l'API « databases » (version 2022-06-28),
 * puis retombe sur l'API « data sources » si Notion l'a retirée entre-temps.
 */
async function lireBase() {
  const pages = [];
  let curseur;

  const tentatives = [
    { url: `${API}/v1/databases/${DB}/query`, version: "2022-06-28" },
    { url: `${API}/v1/data_sources/${DB}/query`, version: "2025-09-03" },
  ];

  let choisie = null;
  let derniereErreur;
  for (const t of tentatives) {
    try {
      const d = await appel(t.url, t.version, { page_size: 100 });
      choisie = t;
      pages.push(...d.results);
      curseur = d.has_more ? d.next_cursor : null;
      break;
    } catch (e) {
      derniereErreur = e;
      console.warn(`  (${t.version} indisponible : ${e.message})`);
    }
  }
  if (!choisie) throw derniereErreur;

  while (curseur) {
    const d = await appel(choisie.url, choisie.version, { page_size: 100, start_cursor: curseur });
    pages.push(...d.results);
    curseur = d.has_more ? d.next_cursor : null;
  }
  return pages;
}

/* ─── Extraction des propriétés ─────────────────────────────────────────── */

const texte = (p) =>
  !p ? "" : (p.rich_text || p.title || []).map((t) => t.plain_text).join("").trim();
const choix = (p) => (p && p.select ? p.select.name : "");
const choixMulti = (p) => (p && p.multi_select ? p.multi_select.map((o) => o.name) : []);
const dateDe = (p) => (p && p.date && p.date.start ? p.date.start.slice(0, 10) : "");

const TYPES = {
  "Alternance": "alternance",
  "CDD 6 mois et +": "cdd",
  "Stage 6 mois et +": "stage",
  "Alternance ou stage": "alternance",
};

/**
 * Filet de sécurité : le fichier produit est public et indexable.
 * Aucune adresse e-mail ni aucun numéro de téléphone ne doit s'y trouver,
 * même si quelqu'un en a saisi un dans Notion par erreur.
 */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const TEL = /(?:(?:\+33|0)\s?[1-9])(?:[\s.-]?\d{2}){4}/g;
let fuites = 0;

function nettoyer(s, ou) {
  if (!s) return s;
  let out = s;
  if (EMAIL.test(out)) {
    fuites++;
    console.warn(`  ⚠ adresse e-mail retirée dans « ${ou} »`);
    out = out.replace(EMAIL, "[contact retiré]");
  }
  if (TEL.test(out)) {
    fuites++;
    console.warn(`  ⚠ numéro de téléphone retiré dans « ${ou} »`);
    out = out.replace(TEL, "[contact retiré]");
  }
  EMAIL.lastIndex = 0;
  TEL.lastIndex = 0;
  return out;
}

function convertir(page) {
  const p = page.properties || {};
  const titre = texte(p["Offre"]);
  if (!titre) return null;

  const etat = choix(p["État"]);
  if (etat === "⚪ Expirée") return null;

  const contrat = choix(p["Contrat"]);
  const lien = (p["Candidater ici"] && p["Candidater ici"].url) || "";

  const o = {
    id: page.id.replace(/-/g, "").slice(0, 16),
    titre: nettoyer(titre, titre),
    entreprise: nettoyer(texte(p["Entreprise"]), titre),
    ville: texte(p["Lieu"]),
    region: texte(p["Région"]),
    filiere: choixMulti(p["Filière"]),
    type: TYPES[contrat] || "alternance",
    date: dateDe(p["Publiée le"]),
    ajoutee: (page.created_time || "").slice(0, 10),
    lien,
  };

  const resume = nettoyer(texte(p["Résumé"]), titre);
  const alerte = nettoyer(texte(p["Alerte"]), titre);
  const mail = nettoyer(texte(p["Mail de candidature"]), titre);
  if (resume) o.resume = resume;
  if (alerte) o.alerte = alerte;
  if (mail) o.mail = mail;

  return o;
}

/* ─── Programme principal ───────────────────────────────────────────────── */

const pages = await lireBase();
console.log(`${pages.length} ligne(s) lue(s) dans Notion.`);

const offres = pages
  .map(convertir)
  .filter(Boolean)
  .sort((a, b) => String(b.date).localeCompare(String(a.date)));

// Garde-fou : ne jamais vider le site à cause d'une panne passagère.
if (offres.length === 0 && existsSync(SORTIE)) {
  let ancien = 0;
  try {
    ancien = (JSON.parse(readFileSync(SORTIE, "utf8")).offres || []).length;
  } catch {}
  if (ancien > 0) {
    console.error(
      `Notion ne renvoie aucune offre alors que le site en affiche ${ancien}. ` +
        `Fichier laissé intact — vérifie la base avant de relancer.`
    );
    process.exit(1);
  }
}

const sortie = {
  maj: new Date().toISOString().slice(0, 10),
  offres,
};

writeFileSync(SORTIE, JSON.stringify(sortie, null, 2) + "\n", "utf8");

const parType = offres.reduce((acc, o) => ((acc[o.type] = (acc[o.type] || 0) + 1), acc), {});
console.log(
  `${offres.length} offre(s) publiée(s) — ` +
    `alternance ${parType.alternance || 0}, CDD ${parType.cdd || 0}, stage ${parType.stage || 0}.`
);
if (fuites) console.log(`${fuites} donnée(s) de contact retirée(s) avant publication.`);
