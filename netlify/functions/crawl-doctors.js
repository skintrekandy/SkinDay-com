// netlify/functions/crawl-doctors.js
//
// Crawls Taiwan clinic websites for doctor names and titles. NO API KEY AND NO
// PER-PAGE COST: the extraction is a parser, not a model call.
//
// Why a parser suffices. Taiwan clinic team pages are extremely regular: a
// doctor is a 2-4 character Chinese name immediately before or after 醫師 /
// 院長 / 主任 / 主治醫師. That is exactly how the 319 Merz doctors were parsed.
// The surname list is what keeps it honest — 主治醫師王小明醫師 yields 王小明
// and not 師王小明, because 師 is not a surname and 王 is.
//
// What this does NOT extract: 學經歷, board certification, societies. Telling a
// hospital post ("台北馬偕紀念醫院皮膚科 主治醫師") apart from a certification
// ("皮膚科專科醫師") is a judgement call that needs a model. Nothing on the site
// displays those fields yet, so they can wait.
//
// Doctors PUBLISH immediately. A clinic listing its own doctors on its own
// website is public information and SkinDay is republishing it, not vouching for
// it. We are not a licensing authority. Corrections come from clinics and
// doctors contacting us. mohw_verified stays false throughout — that column
// means "we checked the registry", not "this doctor is unverified".
//
// Environment variables, all three already set — nothing new needed:
//   SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ADMIN_SECRET

const BATCH_DEFAULT = 5;
const FETCH_TIMEOUT_MS = 12000;
// A real Taiwan aesthetic clinic team is 1-12. More than this many names means
// the page was a news feed, a blog index or a homepage of article teasers, not a
// team page — 醫美時尚雜誌, a magazine, yielded 21. Above the cap we land NOTHING
// and flag the domain, because publishing 36 invented doctors is far worse than
// missing one real team we can re-crawl.
const MAX_PLAUSIBLE_TEAM = 15;

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── Names ───────────────────────────────────────────────────────────────────
// Common Chinese surnames: the filter that makes this approach work at all.
// Only a string starting with a real surname is accepted as a name.
const SURNAME = new Set(('趙錢孫李周吳鄭王馮陳褚衛蔣沈韓楊朱秦尤許何呂施張孔曹嚴華金魏陶姜'
  + '戚謝鄒喻柏水竇章雲蘇潘葛奚范彭郎魯韋昌馬苗鳳花方俞任袁柳酆鮑史唐費廉岑薛雷賀倪湯'
  + '滕殷羅畢郝鄔安常樂于時傅皮卞齊康伍余元卜顧孟平黃和穆蕭尹湛汪祁毛禹狄米貝明臧計伏'
  + '成戴談宋茅龐熊紀舒屈項祝董梁杜阮藍閔席季麻強賈路婁危江童顏郭梅盛林刁鍾徐邱駱高夏'
  + '蔡田樊胡凌霍虞萬支柯昝管盧莫房裘繆干解應宗丁宣賁鄧郁單杭洪包諸左石崔吉鈕龔程嵇邢'
  + '滑裴陸榮翁荀羊惠甄曲家封芮羿儲靳汲邴糜松井段富巫烏焦巴弓牧隗山谷車侯宓蓬全郗班仰'
  + '秋仲伊宮寧仇欒暴甘鈄厲戎祖武符劉景詹束龍葉幸司韶郜黎薊薄印宿白懷蒲邰從鄂索咸籍賴'
  + '卓藺屠蒙池喬陰鬱胥能蒼雙聞莘党翟譚貢勞逄姬申扶堵冉宰雍卻璩桑桂濮牛壽通邊扈燕冀'
  + '郟浦尚農溫別莊晏柴瞿閻充慕連茹習宦艾魚容向古易慎戈廖庾終暨居衡步都耿滿弘匡國文寇'
  + '廣祿闕東歐殳沃利蔚越夔隆師鞏聶晁勾敖融冷訾辛闞那簡饒空曾毋沙乜養鞠須豐巢關蒯相'
  + '查後荊紅游竺權逯蓋益桓公').split(''));

// Real Taiwanese compound and double-barrelled surnames, so four-character names
// survive: 范姜榮香 and 鄭黃中宇 both appear in the Merz data.
const COMPOUND = new Set(['歐陽','司徒','司馬','上官','諸葛','范姜','張簡','夏侯','皇甫',
  '尉遲','公孫','慕容','宇文','長孫','鄭黃','張廖','陳吳','林張','黃陳']);

// Strings that sit immediately before 醫師 but are not names.
const NOT_A_NAME = new Set(['主治','專科','資深','特約','兼任','駐診','本院','我們','每位',
  '所有','各位','團隊','專業','主任','院長','副院','總院','美容','皮膚','整形','醫美','諮詢',
  '合作','指定','推薦','多位','兩位','三位','四位','五位','六位','七位','八位','九位','十位',
  '執業','看診','門診','值班','當日','現場','女性','男性','以上','其他','相關','本站','聯合',
  '主治醫','專任','特聘','資深主','由本','位醫','名醫','等醫','與醫','的醫',
  // Every one of these parsed as a person on the first live run. Each is the
  // tail of a longer phrase whose first character is a genuine surname.
  // Specialties:
  '皮膚科','皮膚部','麻醉科','麻醉','家醫科','內科','外科','眼科','牙科','婦產科','小兒科',
  '復健科','神經科','容專科','容外科','容中心','醫美科','雷射科',
  // Institutions:
  '林口長','高雄醫','高雄榮','國防醫','馬偕紀','馬偕醫','國泰綜','成大醫','台大醫','臺大醫',
  '衛福部','衛生福','華民國','尚診所','榮總醫','慈濟醫','長庚醫','奇美醫','亞東紀',
  // Product and brand names, which appear constantly on these pages:
  '喬雅登','鳳凰電','舒顏萃','艾麗斯','海菲秀','玻尿酸','肉毒桿','洢蓮絲','晶亮瓷','絲儷',
  // Ordinary words:
  '簡介','韓國','權威','須由','能取代','日本','美國','德國','韓式','團隊介','經歷','學歷',
  '專長','認證','原廠','服務','項目','預約','諮詢','時間','地址','電話','關於',
  // FOUR-character specialty and institution phrases are the residual risk: they
  // fall inside the 2-4 boundary window, so the run passes and the 3-char tail
  // then starts with a surname. 乳房外科醫師 yielded 房外科 (房 is a surname).
  // Both the full phrase and its tail have to be listed.
  '乳房外科','房外科','一般外科','般外科','整形外科','形外科','美容外科','容外科',
  '家庭醫學','庭醫學','兒童牙科','童牙科','口腔外科','腔外科','心臟內科','臟內科',
  '腸胃內科','胃內科','神經內科','經內科','新陳代謝','陳代謝','血液腫瘤','液腫瘤',
  // institution tails the boundary rule catches only when the full name is long
  '國立成','花蓮慈','高雄市','高雄長','童綜合','萬芳醫','台北市','臺北市','新北市',
  '台中市','臺中市','台南市','臺南市','桃園市','新竹市','嘉義市','彰化縣','苗栗縣']);

const TITLES = ['總院長', '副院長', '院長', '主任醫師', '主治醫師', '主任', '顧問醫師', '醫師'];
// Words that precede a name but are not titles we record. Trimmed off the front
// of an over-long run so the name inside can still be found.
const ROLE_PREFIX = /^(總院長|副院長|執行長|執行董事|創辦人|院長|主任醫師|主治醫師|顧問醫師|主任|醫師|資深|特約|專任|兼任|駐診|特聘|指定|合作)+/;

const TITLE_RANK = { '總院長': 0, '院長': 1, '副院長': 2, '主任': 3, '主任醫師': 4,
                     '主治醫師': 5, '顧問醫師': 6, '醫師': 7 };

// Given up to four characters sitting before a title, return the actual name.
function nameFromChunk(chunk) {
  if (!chunk) return null;
  // If the WHOLE run is a known non-name, reject it outright. Do not fall back
  // to a shorter suffix: 舒顏萃醫師 (Sculptra) otherwise yielded 顏萃, because
  // 顏 is a surname. A stopword means the phrase is not a person at all.
  if (NOT_A_NAME.has(chunk)) return null;
  if (chunk.length >= 4) {
    const four = chunk.slice(-4);
    if (COMPOUND.has(four.slice(0, 2))) return four;
  }
  for (const len of [3, 2]) {
    if (chunk.length < len) continue;
    const cand = chunk.slice(-len);
    if (NOT_A_NAME.has(cand)) continue;
    if (SURNAME.has(cand[0])) return cand;
  }
  return null;
}

// ── The extractor ───────────────────────────────────────────────────────────
// One pass over the TITLES, not over names. Scanning for names first made a
// greedy group swallow the title itself: "周杰醫師 院長" matched 周杰醫師 as the
// name and 院長 as the title, and 周杰 was lost entirely.
//
// Each title belongs to exactly ONE doctor: the name immediately before it, or
// if there is none, the name immediately after. Without that rule a title bleeds
// onto the next person — "張宏嘉 主治醫師 林宏謙 醫師" gave 林宏謙 the 主治醫師
// that belongs to 張宏嘉.
function extractDoctors(text) {
  const found = new Map();   // name -> most senior title seen

  const consider = (name, title) => {
    if (!name || NOT_A_NAME.has(name)) return;
    const prev = found.get(name);
    if (!prev || TITLE_RANK[title] < TITLE_RANK[prev]) found.set(name, title);
  };

  const titleRe = new RegExp('(' + TITLES.join('|') + ')', 'g');
  let m;
  while ((m = titleRe.exec(text)) !== null) {
    const title = m[1];

    // The four Chinese characters immediately before the title, ignoring
    // punctuation and whitespace between them.
    // Strip any OTHER title words out of the preceding text first. In
    // "葉昱廷 醫師 許嵐 醫師" the second 醫師 is preceded by the first one, and
    // without this the name came out as 師許嵐 — 師 is itself a rare surname.
    // It also kills prose false positives: "多位醫師駐診，主治醫師均具備" gave
    // 師駐診 before this line existed.
    // THE BOUNDARY RULE, and it is what stops phrase fragments.
    // A name sits at a word boundary: after a space, punctuation, a line break
    // or the start of the text. A specialty or an institution does not.
    //   "台北馬偕紀念醫院皮膚科主治醫師" -> the run of Chinese before the title is
    //   11 characters long, so 皮膚科 is part of a phrase, not a name.
    //   "彭賢禮 院長" -> skip the space, the run is 3 characters. A name.
    // Without this, 皮膚科醫師 parsed as a person 61 times, because 皮 is a real
    // surname. Same for 麻醉科, 林口長庚, 醫學美容中心, 簡介, 韓國.
    const raw = text.slice(Math.max(0, m.index - 24), m.index)
                    .replace(new RegExp('(' + TITLES.join('|') + ')\\s*$'), '');
    const runMatch = raw.match(/([\u4e00-\u9fff]+)[\s\u3000·、,，.。:：|｜/()（）\[\]-]*$/);
    let run = runMatch ? runMatch[1] : '';
    // Role words that are NOT in TITLES still glue onto the front of a name when
    // there is no space: 執行長孫克嘉醫師 gave 長孫克嘉, because 長孫 is a genuine
    // compound surname (長孫無忌). Trim these off an over-long run and re-check.
    if (run.length > 4) run = run.replace(ROLE_PREFIX, '');
    const lead = (run.length >= 2 && run.length <= 4) ? run : '';
    const beforeName = nameFromChunk(lead);
    if (beforeName) { consider(beforeName, title); continue; }

    // Nothing usable before it, so the title may introduce the name instead:
    // 院長 王修含
    const rawTail = text.slice(m.index + title.length, m.index + title.length + 24)
                        .replace(new RegExp('^\\s*(' + TITLES.join('|') + ')'), '');
    const tailMatch = rawTail.match(/^[\s\u3000·、,，.。:：|｜/()（）\[\]-]*([\u4e00-\u9fff]+)/);
    const tailRun = tailMatch ? tailMatch[1] : '';
    const tail = (tailRun.length >= 2 && tailRun.length <= 4) ? tailRun : '';
    let afterName = null;
    if (tail.length >= 4 && COMPOUND.has(tail.slice(0, 2))) afterName = tail.slice(0, 4);
    else if (tail.length >= 2 && SURNAME.has(tail[0]) && !NOT_A_NAME.has(tail.slice(0, 2))) {
      afterName = tail.slice(0, Math.min(3, tail.length));
    }
    consider(afterName, title);
  }

  return [...found.entries()].map(([name_zh, title]) => ({ name_zh, title }));
}

// ── Supabase helpers ────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── Fetching a page, with a timeout so one dead host cannot stall the batch ──
async function getPage(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'SkinDayBot/1.0 (+https://skinday.com)' }
    });
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    const html = await r.text();
    return { ok: true, html, finalUrl: r.url || url };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ── Finding the team page ───────────────────────────────────────────────────
// Every site names it differently: /醫師介紹/, /about/our-team/, /team/,
// /doctorall. So read the homepage's links and score them.
const TEAM_HINTS = [
  ['醫師介紹', 100], ['醫師團隊', 100], ['專業團隊', 95], ['醫療團隊', 95],
  ['our-team', 90], ['doctorall', 90], ['醫師陣容', 90], ['團隊', 70],
  ['doctor', 65], ['醫師', 60], ['team', 55], ['physician', 55], ['staff', 30]
];

function findTeamUrl(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    // A blog post titled "醫師談皮秒雷射" scores as high as a team page and is
    // full of other clinics' doctors. Never follow content URLs.
    if (/\/(blog|news|article|articles|post|posts|category|tag|archive|column|faq|case|cases|video|activity|event|promo)(\/|$|\?)/i.test(href)
        || /[?&]p=\d|[?&]page_id=/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    if (new URL(abs).hostname !== new URL(baseUrl).hostname) continue;   // same site only
    const hay = (decodeURIComponent(abs) + ' ' + label).toLowerCase();
    let score = 0;
    for (const [word, w] of TEAM_HINTS) if (hay.includes(word.toLowerCase())) score = Math.max(score, w);
    if (score) links.push({ abs, score });
  }
  links.sort((a, b) => b.score - a.score);
  return links.length ? links[0].abs : null;
}

// ── Page text, because the model should read prose and not markup ───────────
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 120000);
}

// ── Landing the rows. Unpublished, always. ──────────────────────────────────
async function land(doctors, clinicId, sourceUrl) {
  let created = 0, linked = 0;
  for (const d of doctors) {
    const name = (d.name_zh || '').trim();
    if (!name) continue;

    const found = await sb(`doctors?select=id&name_zh=eq.${encodeURIComponent(name)}&limit=1`);
    let id = found && found.length ? found[0].id : null;

    if (!id) {
      const made = await sb('doctors', {
        method: 'POST',
        body: JSON.stringify({
          name_zh: name,
          source_url: sourceUrl,
          evidence_type: 'clinic_declared',   // set explicitly; never rely on the column default
          review_status: 'approved',
          published: true
        })
      });
      id = made && made[0] && made[0].id;
      if (id) created++;
    }
    if (!id) continue;

    const link = await sb(`clinic_doctors?select=id&clinic_id=eq.${encodeURIComponent(clinicId)}&doctor_id=eq.${id}&limit=1`);
    if (!link || !link.length) {
      await sb('clinic_doctors', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ clinic_id: clinicId, doctor_id: id, title: d.title || null })
      });
      linked++;
    }
  }
  return { created, linked };
}

// ── One domain ──────────────────────────────────────────────────────────────
async function crawlOne(row) {
  const home = await getPage(row.home_url);
  if (!home.ok) return { status: 'error', last_error: `home: ${home.error}` };

  const teamUrl = findTeamUrl(home.html, home.finalUrl) || home.finalUrl;
  const page = teamUrl === home.finalUrl ? home : await getPage(teamUrl);
  if (!page.ok) return { status: 'error', team_url: teamUrl, last_error: `team: ${page.error}` };

  const text = toText(page.html);
  if (text.length < 200) {
    // A JavaScript shell yields a title and a copyright line and nothing else.
    return { status: 'needs_render', team_url: teamUrl, last_error: 'page has almost no text' };
  }

  let doctors = extractDoctors(text);

  // If the team page gave nothing, the homepage sometimes carries the roster in
  // a 門診時間 table — dermayoung.com.tw does exactly that.
  if (!doctors.length && teamUrl !== home.finalUrl) doctors = extractDoctors(toText(home.html));
  if (!doctors.length) return { status: 'empty', team_url: teamUrl, doctors_found: 0 };

  if (doctors.length > MAX_PLAUSIBLE_TEAM) {
    return { status: 'suspicious', team_url: teamUrl, doctors_found: doctors.length,
             last_error: 'yielded ' + doctors.length + ' names — likely not a team page, nothing landed' };
  }

  const { created, linked } = await land(doctors, row.clinic_id, teamUrl);
  return { status: 'done', team_url: teamUrl, doctors_found: doctors.length, created, linked,
           names: doctors.slice(0, 6).map(d => d.name_zh).join('、') };
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const json = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  // Same gate as taiwan-admin: this writes to the database.
  const given = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!ADMIN_SECRET || given !== ADMIN_SECRET) return json(401, { error: 'unauthorised' });

  if (!SB || !SB_KEY) return json(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const batch = Math.min(Math.max(parseInt(body.batch, 10) || BATCH_DEFAULT, 1), 8);
  const retry = body.retry === true;   // re-run rows that previously errored

  try {
    const want = retry ? 'in.(pending,error)' : 'eq.pending';
    const claim = await sb(`crawl_queue?select=*&status=${want}&order=id.asc&limit=${batch}`);
    if (!claim || !claim.length) {
      const left = await sb('crawl_queue?select=status', { prefer: 'count=exact' });
      return json(200, { done: true, processed: [], remaining: 0, note: 'queue empty', total: (left || []).length });
    }

    const ids = claim.map(r => r.id);
    await sb(`crawl_queue?id=in.(${ids.join(',')})`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ status: 'running' })
    });

    const processed = [];
    for (const row of claim) {
      let result;
      try { result = await crawlOne(row); }
      catch (e) { result = { status: 'error', last_error: String(e.message || e).slice(0, 400) }; }

      await sb(`crawl_queue?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({
          status: result.status,
          team_url: result.team_url || null,
          doctors_found: result.doctors_found || 0,
          last_error: result.last_error || null,
          attempts: (row.attempts || 0) + 1,
          fetched_at: new Date().toISOString()
        })
      });

      processed.push({
        domain: row.domain,
        status: result.status,
        doctors: result.doctors_found || 0,
        created: result.created || 0,
        linked: result.linked || 0,
        names: result.names || null,
        team_url: result.team_url || null,
        error: result.last_error || null
      });
    }

    const pending = await sb('crawl_queue?select=id&status=eq.pending', { prefer: 'count=exact' });
    return json(200, {
      done: false,
      processed,
      remaining: (pending || []).length
    });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 500) });
  }
};
