require('dotenv').config();

// Automatische DSGVO-Löschung: Einträge in Redis (und die dazugehörige
// Live-Präsentation auf GitHub/Vercel) werden 6 Monate nach Erstellung
// gelöscht. Läuft als Vercel Cron (siehe vercel.json).

const REDIS_URL    = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const VERCEL_TOKEN  = process.env.VERCEL_TOKEN;
const CRON_SECRET   = process.env.CRON_SECRET;

const RETENTION_MS = 6 * 30 * 24 * 60 * 60 * 1000; // 6 Monate (fixe Frist, kein Status-Tracking)
const CLEANUP_LOG_KEY = 'cleanup_log';
const CLEANUP_LOG_MAX = 200;

async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  return json.result;
}

async function getList(key) {
  const raw = await redisCmd('GET', key);
  return raw ? JSON.parse(raw) : [];
}

async function gh(method, apiPath) {
  const res = await fetch('https://api.github.com' + apiPath, {
    method,
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
  });
  return { status: res.status };
}

async function vc(method, apiPath) {
  const res = await fetch('https://api.vercel.com' + apiPath, {
    method,
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
  });
  return { status: res.status };
}

// 204 = gelöscht, 404 = war schon weg -> beides zählt als "erledigt"
async function deleteRepo(repo) {
  if (!repo) return true;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return true;
  const res = await gh('DELETE', `/repos/${owner}/${name}`);
  return res.status === 204 || res.status === 404;
}

async function deleteVercelProject(projectId) {
  if (!projectId) return true;
  const res = await vc('DELETE', `/v9/projects/${projectId}`);
  return res.status === 204 || res.status === 404;
}

function isExpired(entry, cutoff) {
  const created = entry.createdAt ? new Date(entry.createdAt).getTime() : NaN;
  return Number.isFinite(created) && created < cutoff;
}

// Reine Metadaten (kein externes Live-Deployment): einfach nach Alter filtern.
async function cleanupSimpleList(key, cutoff, dryRun) {
  const list = await getList(key);
  const keep = list.filter(e => !isExpired(e, cutoff));
  const removed = list.filter(e => isExpired(e, cutoff));
  if (!dryRun && removed.length) {
    await redisCmd('SET', key, JSON.stringify(keep));
  }
  return { key, totalBefore: list.length, removed: removed.length, removedEntries: removed };
}

// Präsentationen: zusätzlich GitHub-Repo + Vercel-Projekt löschen (= Live-Site
// deaktivieren). Ein Eintrag wird nur aus Redis entfernt, wenn beide externen
// Löschungen geklappt haben (oder das jeweilige Ziel eh schon weg war) — sonst
// bleibt er stehen und wird beim nächsten Lauf erneut versucht.
async function cleanupPresentations(cutoff, dryRun) {
  const key = 'praesentationen';
  const list = await getList(key);
  const keep = [];
  const removed = [];
  const failed = [];

  for (const entry of list) {
    if (!isExpired(entry, cutoff)) {
      keep.push(entry);
      continue;
    }
    if (dryRun) {
      removed.push(entry);
      continue;
    }
    const [repoOk, projectOk] = await Promise.all([
      deleteRepo(entry.repo),
      deleteVercelProject(entry.projectId),
    ]);
    if (repoOk && projectOk) {
      removed.push(entry);
    } else {
      console.warn('Konnte Live-Präsentation nicht vollständig löschen, versuche es beim nächsten Lauf erneut:', entry.companyName, entry.repo, entry.projectId);
      failed.push(entry);
      keep.push(entry);
    }
  }

  if (!dryRun && removed.length) {
    await redisCmd('SET', key, JSON.stringify(keep));
  }

  return { key, totalBefore: list.length, removed: removed.length, removedEntries: removed, failed: failed.length };
}

async function appendCleanupLog(summary) {
  try {
    const log = await getList(CLEANUP_LOG_KEY);
    log.unshift({ ranAt: new Date().toISOString(), ...summary });
    if (log.length > CLEANUP_LOG_MAX) log.splice(CLEANUP_LOG_MAX);
    await redisCmd('SET', CLEANUP_LOG_KEY, JSON.stringify(log));
  } catch (err) {
    console.warn('Konnte Cleanup-Log nicht schreiben:', err.message);
  }
}

module.exports = async (req, res) => {
  // Vercel Cron schickt automatisch "Authorization: Bearer $CRON_SECRET",
  // wenn CRON_SECRET als Env-Var gesetzt ist. So verhindern wir, dass jemand
  // die Löschung über die öffentliche URL manuell auslöst.
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: 'Redis nicht konfiguriert.' });
  }
  if (!GITHUB_TOKEN || !VERCEL_TOKEN) {
    return res.status(503).json({ error: 'GITHUB_TOKEN/VERCEL_TOKEN nicht konfiguriert.' });
  }

  const dryRun = req.query?.dryRun === '1';
  const cutoff = Date.now() - RETENTION_MS;

  try {
    const [schulcards, praesentationen, angebote] = await Promise.all([
      cleanupSimpleList('schulcards', cutoff, dryRun),
      cleanupPresentations(cutoff, dryRun),
      cleanupSimpleList('angebote', cutoff, dryRun),
    ]);

    const summary = {
      dryRun,
      cutoffDate: new Date(cutoff).toISOString(),
      schulcards: { totalBefore: schulcards.totalBefore, removed: schulcards.removed },
      praesentationen: { totalBefore: praesentationen.totalBefore, removed: praesentationen.removed, failed: praesentationen.failed },
      angebote: { totalBefore: angebote.totalBefore, removed: angebote.removed },
    };

    if (!dryRun) await appendCleanupLog(summary);

    return res.json({
      ...summary,
      // Details nur bei dryRun zurückgeben (zum Testen) — im echten Lauf
      // landen keine personenbezogenen Daten in der Response/den Logs.
      details: dryRun ? { schulcards: schulcards.removedEntries, praesentationen: praesentationen.removedEntries, angebote: angebote.removedEntries } : undefined,
    });
  } catch (err) {
    console.error('Cleanup-Fehler:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { maxDuration: 60 };
