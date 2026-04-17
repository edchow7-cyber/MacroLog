// MacroLog Cloudflare Worker
// Storage: Cloudflare KV (bind namespace as MACROLOG)
// Deploy at: https://dash.cloudflare.com

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-MacroLog-Token',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // Optional token auth — set MACROLOG_TOKEN env variable in Cloudflare dashboard to enable
    if (env.MACROLOG_TOKEN) {
      const provided = url.searchParams.get('token') || request.headers.get('x-macrolog-token');
      if (provided !== env.MACROLOG_TOKEN) {
        return json({ error: 'Unauthorized' }, 401);
      }
    }

    try {
      if (request.method === 'GET') return await handleGet(url, env);
      if (request.method === 'POST') return await handlePost(request, env);
    } catch (err) {
      return json({ error: err.toString() }, 500);
    }

    return new Response('Method not allowed', { status: 405 });
  }
};

// ── GET handler ───────────────────────────────────────

async function handleGet(url, env) {
  const type = url.searchParams.get('type') || 'log';

  if (type === 'targets') {
    const targets = await env.MACROLOG.get('targets', 'json');
    return json({ targets: targets || null });
  }

  if (type === 'recipes') {
    const recipes = await env.MACROLOG.get('recipes', 'json') || [];
    return json({ recipes });
  }

  if (type === 'export') {
    return await handleExport(url, env);
  }

  if (type === 'dashboard') {
    return await handleDashboard(env);
  }

  // Default: log for a specific date
  const date = url.searchParams.get('date');
  const rows = await env.MACROLOG.get(`log:${date}`, 'json') || [];
  return json({ rows });
}

// ── Export handler ────────────────────────────────────

async function handleExport(url, env) {
  const data = url.searchParams.get('data') || 'log';

  if (data === 'recipes') {
    const recipes = await env.MACROLOG.get('recipes', 'json') || [];
    const header = 'Food,Calories,Protein (g),Carbs (g),Fat (g),Fiber (g),Notes\n';
    const rows = recipes.map(r =>
      `"${esc(r.food)}",${r.calories},${r.protein},${r.carbs},${r.fat},${r.fiber || 0},"${esc(r.notes || '')}"`
    ).join('\n');
    return csv(header + rows, 'macrolog-recipes.csv');
  }

  if (data === 'targets') {
    const t = await env.MACROLOG.get('targets', 'json') || {};
    const header = 'Calories,Protein (g),Carbs (g),Fat (g),Fiber (g)\n';
    const row = `${t.calories || 0},${t.protein || 0},${t.carbs || 0},${t.fat || 0},${t.fiber || 0}`;
    return csv(header + row, 'macrolog-targets.csv');
  }

  // Full log export — fetch all date keys
  const list = await env.MACROLOG.list({ prefix: 'log:' });
  const allRows = [];
  for (const key of list.keys) {
    const rows = await env.MACROLOG.get(key.name, 'json') || [];
    allRows.push(...rows);
  }
  allRows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const header = 'Date,Time,Food,Calories,Protein (g),Carbs (g),Fat (g),Fiber (g),Notes\n';
  const rows = allRows.map(r =>
    `${r.date},${r.time},"${esc(r.food)}",${r.calories},${r.protein},${r.carbs},${r.fat},${r.fiber || 0},"${esc(r.notes || '')}"`
  ).join('\n');
  return csv(header + rows, 'macrolog-log.csv');
}

// ── Dashboard ─────────────────────────────────────────

async function handleDashboard(env) {
  const today = new Date().toLocaleDateString('en-CA');
  const todayRows = await env.MACROLOG.get(`log:${today}`, 'json') || [];
  const targets = await env.MACROLOG.get('targets', 'json') || { calories: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30 };
  const recipes = await env.MACROLOG.get('recipes', 'json') || [];
  const list = await env.MACROLOG.list({ prefix: 'log:' });

  const totals = todayRows.reduce((a, e) => ({
    calories: a.calories + (e.calories || 0), protein: a.protein + (e.protein || 0),
    carbs: a.carbs + (e.carbs || 0), fat: a.fat + (e.fat || 0), fiber: a.fiber + (e.fiber || 0)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

  const bar = (label, cur, goal, color) => {
    const pct = Math.min(100, Math.round((cur / goal) * 100));
    const over = cur > goal;
    return `<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
        <span style="color:#888;text-transform:capitalize">${label}</span>
        <span style="font-weight:600;color:${over ? '#d94f4f' : '#1a1a18'}">${over ? Math.round(cur - goal) + ' over' : Math.round(goal - cur) + ' left'}</span>
      </div>
      <div style="height:6px;border-radius:3px;background:#f0ede8;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${over ? '#d94f4f' : color};border-radius:3px"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#aaa;margin-top:2px">
        <span>${Math.round(cur)}</span><span>${goal}</span>
      </div>
    </div>`;
  };

  const workerUrl = 'YOUR_WORKER_URL'; // replaced at runtime below
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MacroLog Dashboard</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f5f3ef;color:#1a1a18;max-width:480px;margin:0 auto;padding:20px 16px}
h1{font-size:20px;font-weight:700;margin-bottom:4px}
.sub{font-size:13px;color:#888;margin-bottom:20px}
.card{background:#fff;border-radius:16px;border:1px solid rgba(0,0,0,0.09);padding:16px;margin-bottom:12px}
.card-label{font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px}
.entry{padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:14px}
.entry:last-child{border-bottom:none}
.entry-food{font-weight:600}
.entry-macros{font-size:12px;color:#888;margin-top:2px}
.export-links{display:flex;flex-direction:column;gap:8px}
a.export-btn{display:block;padding:12px 16px;background:#2d6e47;color:#fff;text-decoration:none;border-radius:10px;font-size:14px;font-weight:600;text-align:center}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.stat{background:#f0ede8;border-radius:10px;padding:10px;text-align:center}
.stat-val{font-size:20px;font-weight:700;color:#2d6e47}
.stat-label{font-size:11px;color:#888;margin-top:2px}
</style></head><body>
<h1>MacroLog</h1>
<div class="sub">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</div>
<div class="stats">
  <div class="stat"><div class="stat-val">${todayRows.length}</div><div class="stat-label">entries today</div></div>
  <div class="stat"><div class="stat-val">${list.keys.length}</div><div class="stat-label">days logged</div></div>
  <div class="stat"><div class="stat-val">${recipes.length}</div><div class="stat-label">recipes</div></div>
</div>
<div class="card">
  <div class="card-label">Today's progress</div>
  ${bar('calories', totals.calories, targets.calories, '#d94f4f')}
  ${bar('protein', totals.protein, targets.protein, '#2d8c5a')}
  ${bar('carbs', totals.carbs, targets.carbs, '#d4891a')}
  ${bar('fat', totals.fat, targets.fat, '#6b55c0')}
  ${bar('fiber', totals.fiber, targets.fiber, '#1a78b4')}
</div>
${todayRows.length ? `<div class="card">
  <div class="card-label">Today's entries</div>
  ${[...todayRows].reverse().map(e => `<div class="entry">
    <div class="entry-food">${e.food}</div>
    <div class="entry-macros">${e.time} · ${Math.round(e.calories)} kcal · P ${Math.round(e.protein)}g · C ${Math.round(e.carbs)}g · F ${Math.round(e.fat)}g · Fi ${Math.round(e.fiber || 0)}g</div>
  </div>`).join('')}
</div>` : ''}
<div class="card">
  <div class="card-label">Export your data</div>
  <div class="export-links">
    <a class="export-btn" href="?type=export&data=log">⬇ Download full log (CSV)</a>
    <a class="export-btn" href="?type=export&data=recipes" style="background:#1a78b4">⬇ Download recipes (CSV)</a>
    <a class="export-btn" href="?type=export&data=targets" style="background:#6b55c0">⬇ Download targets (CSV)</a>
  </div>
</div>
</body></html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html;charset=utf-8' } });
}

// ── POST handler ──────────────────────────────────────

async function handlePost(request, env) {
  const d = await request.json();

  if (d.action === 'save_targets') {
    await env.MACROLOG.put('targets', JSON.stringify({
      calories: d.calories, protein: d.protein, carbs: d.carbs, fat: d.fat, fiber: d.fiber || 30
    }));
    return json({ success: true });
  }

  if (d.action === 'save_recipe') {
    const recipes = await env.MACROLOG.get('recipes', 'json') || [];
    recipes.push({ food: d.food, calories: d.calories, protein: d.protein, carbs: d.carbs, fat: d.fat, fiber: d.fiber || 0, notes: d.notes || '', id: d.id });
    await env.MACROLOG.put('recipes', JSON.stringify(recipes));
    return json({ success: true });
  }

  if (d.action === 'delete_recipe') {
    const recipes = (await env.MACROLOG.get('recipes', 'json') || []).filter(r => Number(r.id) !== Number(d.id));
    await env.MACROLOG.put('recipes', JSON.stringify(recipes));
    return json({ success: true });
  }

  if (d.action === 'log') {
    const rows = await env.MACROLOG.get(`log:${d.date}`, 'json') || [];
    rows.push({ date: d.date, time: d.time, food: d.food, calories: d.calories, protein: d.protein, carbs: d.carbs, fat: d.fat, fiber: d.fiber || 0, notes: d.notes || '', id: d.id });
    await env.MACROLOG.put(`log:${d.date}`, JSON.stringify(rows));
    return json({ success: true });
  }

  if (d.action === 'delete') {
    const date = d.date;
    const rows = (await env.MACROLOG.get(`log:${date}`, 'json') || []).filter(r => Number(r.id) !== Number(d.id));
    await env.MACROLOG.put(`log:${date}`, JSON.stringify(rows));
    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
}

// ── Helpers ───────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

function csv(body, filename) {
  return new Response(body, {
    headers: {
      ...CORS,
      'Content-Type': 'text/csv;charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  });
}

function esc(str) {
  return String(str).replace(/"/g, '""');
}
