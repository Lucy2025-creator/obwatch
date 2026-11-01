// 在 GitHub Actions 里跑：抓官方仓库/组织/账号的变动，写 state.json + data.json
// 不依赖任何本机进程，跑完由 workflow 提交，push 触发 Pages 部署
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, 'state.json');
const DATA_FILE = path.join(ROOT, 'data.json');
const TOKEN = process.env.GITHUB_TOKEN || '';

const REPOS = [
  'oceanbase/seekdb',
  'oceanbase/powercontext',
  'oceanbase/oceanbase',
  'oceanbase/ob-mldr-test',
  'oceanbase/powerrag',
];
const ORGS = ['oceanbase'];
const USERS = ['hnwyllmm', 'PsiACE'];

const INTERESTING_BRANCH = /(2026|2025|competition|contest|final[-_]?competition|赛题|training|ecosystem|track)/i;
const INTERESTING_TAG = /(2026|2025|competition|contest|final[-_]?competition|赛题)/i;
const TOPIC_NAME = /(seekdb|powercontext|oceanbase)[-_ .]*(competition|contest|2026)|(competition|contest|2026)[-_ .]*(seekdb|powercontext|oceanbase)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

async function api(p, { accept = 'application/vnd.github+json', raw = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(p.startsWith('http') ? p : 'https://api.github.com' + p, {
        headers: {
          'user-agent': 'obwatch-cloud',
          accept,
          'x-github-api-version': '2022-11-28',
          ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw new Error(`HTTP ${res.status} ${p} ${(await res.text()).slice(0, 120)}`);
      if (raw) return { text: await res.text() };
      return { data: await res.json() };
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function paged(p, maxPages = 3) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = p.includes('?') ? '&' : '?';
    const { data } = await api(`${p}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data)) break;
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

// ---------- 赛题识别（与本地 watch.mjs 同一套规则） ----------
const TOPIC_RULES = [
  { re: /赛题/g, w: 4 },
  { re: /(初赛|决赛)/g, w: 3 },
  { re: /(大赛|竞赛)/g, w: 2 },
  { re: /(测评|评测|评分|判题|排行榜|训练营)/g, w: 2 },
  { re: /(提交|提测)/g, w: 1 },
  { re: /(题目|赛道|方向)/g, w: 1 },
  { re: /competition/gi, w: 3 },
  { re: /contest/gi, w: 3 },
  { re: /challenge/gi, w: 2 },
  { re: /submission/gi, w: 1 },
  { re: /benchmark/gi, w: 1 },
  { re: /2026/g, w: 1 },
  { re: /(final|qualifier)/gi, w: 2 },
  { re: /(track|leaderboard)/gi, w: 1 },
];

function judgeTopic(name, desc, readme = '', branch = '', commits = []) {
  const blob = [name, desc, readme, branch, ...commits].join('\n');
  let score = 0;
  const hits = new Set();
  for (const r of TOPIC_RULES) {
    const m = blob.match(r.re);
    if (m) {
      score += r.w * Math.min(m.length, 4);
      hits.add(r.re.source.slice(0, 24));
    }
  }
  if (TOPIC_NAME.test(name)) {
    score += 6;
    hits.add('名字含赛事词');
  }
  const strongBranch = /(2026|2025)[-_ .]?(final[-_ ]?)?competition|competition[-_ .]?(2026|2025)|final[-_ ]?competition|赛题/i.test(branch);
  if (strongBranch) {
    score += 6;
    hits.add('分支名含赛事词');
  }
  const hasSaite = /赛题/.test(blob);
  const hasWorkflow = /(提交|提测|评分|判题|测评|决赛|初赛|训练营)/.test(blob);
  const strong = strongBranch || score >= 10 || (hasSaite && hasWorkflow && score >= 6) || score >= 16;
  return { score, strong, hits: [...hits] };
}

function newEvent(e) {
  const id = ssha([e.kind, e.repo, e.branch || '', e.sha || '', e.title || ''].join('|'));
  return { id, ts: new Date().toISOString(), ...e };
}

// ---------- 状态 ----------
let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {
  state = { version: 1, initialized: false, refs: {}, orgRepos: {}, userRepos: {}, events: [], seen: [] };
}
state.refs ||= {};
state.orgRepos ||= {};
state.userRepos ||= {};
state.events ||= [];
state.seen ||= [];

const baseline = !state.initialized;
const events = [];
const prevRefs = JSON.parse(JSON.stringify(state.refs));

// 1) 仓库分支/标签
for (const repo of REPOS) {
  try {
    const branches = {};
    for (const b of await paged(`/repos/${repo}/branches`, 2)) branches[b.name] = b.commit.sha;
    const tags = {};
    for (const t of await paged(`/repos/${repo}/tags`, 2)) tags[t.name] = t.commit.sha;
    const prev = prevRefs[repo];
    if (prev) {
      for (const [name, sha] of Object.entries(branches)) {
        const interesting = INTERESTING_BRANCH.test(name);
        if (!(name in prev.branches)) {
          if (interesting) {
            events.push(
              newEvent({
                kind: 'branch_new',
                repo,
                branch: name,
                sha,
                title: `${repo} 新分支 ${name}`,
                url: `https://github.com/${repo}/tree/${name}`,
                topic: judgeTopic(`${repo}`, '', '', name),
              })
            );
          }
        } else if (prev.branches[name] !== sha && interesting) {
          events.push(
            newEvent({
              kind: 'branch_update',
              repo,
              branch: name,
              sha,
              prevSha: prev.branches[name],
              title: `${repo} 分支 ${name} 更新`,
              url: `https://github.com/${repo}/compare/${prev.branches[name]}...${sha}`,
              topic: judgeTopic(repo, '', '', name),
            })
          );
        }
      }
      for (const name of Object.keys(prev.branches)) {
        if (!(name in branches) && INTERESTING_BRANCH.test(name)) {
          events.push(newEvent({ kind: 'branch_deleted', repo, branch: name, title: `${repo} 比赛相关分支被删除：${name}`, url: `https://github.com/${repo}/branches` }));
        }
      }
      for (const [name, sha] of Object.entries(tags)) {
        if (!(name in prev.tags) && INTERESTING_TAG.test(name)) {
          events.push(newEvent({ kind: 'tag_new', repo, tag: name, sha, title: `${repo} 新标签 ${name}`, url: `https://github.com/${repo}/releases/tag/${name}` }));
        }
      }
    }
    state.refs[repo] = { branches, tags };
    console.log(repo, Object.keys(branches).length, 'branches', Object.keys(tags).length, 'tags');
  } catch (e) {
    console.log('WARN repo', repo, e.message);
  }
}

// 2) 组织新仓库
for (const org of ORGS) {
  try {
    const list = await paged(`/orgs/${org}/repos?sort=created&direction=desc`, 2);
    const cur = list.map((r) => ({ name: r.name, full: r.full_name, desc: r.description || '', created: r.created_at, url: r.html_url }));
    const prev = new Set(state.orgRepos[org] || []);
    if (state.orgRepos[org]) {
      for (const r of cur) {
        if (prev.has(r.name)) continue;
        let readme = '';
        try {
          readme = (await api(`/repos/${r.full}/readme`, { accept: 'application/vnd.github.raw', raw: true })).text?.slice(0, 12000) || '';
        } catch {}
        const topic = judgeTopic(`${r.full} ${org} 新建仓库 ${r.name}`, r.desc, readme);
        events.push(newEvent({ kind: 'repo_new', repo: r.full, title: `${org} 新建仓库 ${r.name}`, url: r.url, created: r.created, desc: r.desc, topic, readme: readme.replace(/\s+/g, ' ').slice(0, 240) }));
      }
    }
    state.orgRepos[org] = [...new Set([...(state.orgRepos[org] || []), ...cur.map((r) => r.name)])];
    console.log(org, cur.length, 'repos');
  } catch (e) {
    console.log('WARN org', org, e.message);
  }
}

// 3) 开发者账号新仓库
for (const user of USERS) {
  try {
    const list = await paged(`/users/${user}/repos?sort=created&direction=desc`, 2);
    const cur = list.filter((r) => !r.fork).map((r) => ({ name: r.name, full: r.full_name, desc: r.description || '', created: r.created_at, url: r.html_url }));
    const prev = new Set(state.userRepos[user] || []);
    if (state.userRepos[user]) {
      for (const r of cur) {
        if (prev.has(r.name)) continue;
        let readme = '';
        try {
          readme = (await api(`/repos/${r.full}/readme`, { accept: 'application/vnd.github.raw', raw: true })).text?.slice(0, 12000) || '';
        } catch {}
        const topic = judgeTopic(`${r.full} 新建仓库 ${r.name}`, r.desc, readme);
        events.push(newEvent({ kind: 'user_repo_new', repo: r.full, title: `${user} 新建仓库 ${r.name}`, url: r.url, created: r.created, desc: r.desc, topic, readme: readme.replace(/\s+/g, ' ').slice(0, 240) }));
      }
    }
    state.userRepos[user] = [...new Set([...(state.userRepos[user] || []), ...cur.map((r) => r.name)])];
    console.log(user, cur.length, 'repos');
  } catch (e) {
    console.log('WARN user', user, e.message);
  }
}

// 4) 事件入库（去重）
const fresh = [];
for (const e of events) {
  if (state.seen.includes(e.id)) continue;
  state.seen.push(e.id);
  fresh.push(e);
}
if (state.seen.length > 800) state.seen = state.seen.slice(-800);
if (!baseline && fresh.length) {
  state.events.push(...fresh.map((e) => ({ ...e, readme: e.readme || '' })));
  if (state.events.length > 80) state.events = state.events.slice(-80);
}

// 5) 生成页面数据
const pageRepos = REPOS.map((name) => {
  const r = state.refs[name] || { branches: {}, tags: {} };
  return {
    name,
    url: `https://github.com/${name}`,
    branchCount: Object.keys(r.branches).length,
    tagCount: Object.keys(r.tags).length,
    branches: Object.entries(r.branches)
      .filter(([b]) => INTERESTING_BRANCH.test(b))
      .map(([b, sha]) => ({ name: b, sha, url: `https://github.com/${name}/tree/${b}` })),
  };
});
const data = {
  ok: true,
  generatedAt: Date.now(),
  lastCheckAt: Date.now(),
  nextCheckAt: Date.now() + 15 * 60 * 1000,
  watch: { repos: REPOS, orgs: ORGS, users: USERS },
  repos: pageRepos,
  events: state.events.slice().reverse().map((e) => ({
    ts: e.ts,
    kind: e.kind,
    repo: e.repo,
    branch: e.branch || null,
    sha: e.sha || null,
    title: e.title,
    url: e.url || null,
    strong: !!e.topic?.strong,
    score: e.topic?.score || 0,
    clone: null,
  })),
  clones: [],
  stats: { repos: pageRepos.length, events: state.events.length },
};

state.initialized = true;
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
console.log(`baseline=${baseline} fresh=${fresh.length} totalEvents=${state.events.length}`);
