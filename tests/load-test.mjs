// اختبار الضغط المتزامن لمسابقة سراج الثقافية
// يتطلب Node.js 18 أو أحدث. التشغيل:
//   node tests/load-test.mjs --url "https://script.google.com/macros/s/XXXX/exec" --count 50
//   node tests/load-test.mjs --url "..." --count 1000 --spread 3000
//
// قبل التشغيل: فعّل وضع الاختبار من قائمة "إدارة سراج" واضبط الوقت داخل نافذة سؤال جاهز (مثلاً 2026-11-15 19:00).
// بعد الانتهاء: شغّل "حذف بيانات اختبار التحميل" من القائمة (يحذف كل رقم جامعي يبدأ بـ 99000).
//
// ماذا يفعل:
//  1) يسجّل N مشاركاً وهمياً (أرقام جامعية 99000000 فما فوق) بتوازٍ محدود.
//  2) يرسل N إجابة في نفس اللحظة (أو موزعة على --spread ملّي ثانية)، مع نفس منطق إعادة المحاولة في الموقع.
//  3) يرسل لعدد من المشاركين إجابة ثانية متزامنة مع الأولى للتأكد أن الخادم يقبل إجابة واحدة فقط.
//  4) يطبع تقريراً: المقبول، المكرر المرفوض، الأخطاء، وأزمنة الاستجابة.

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => {
  if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const URL_ = args.url;
const COUNT = Number(args.count || 50);
const SPREAD = Number(args.spread || 0);
const DUP_SHARE = Number(args.dups || 0.2);
const REG_CONCURRENCY = Number(args.regConcurrency || 10);
if (!URL_) { console.error('حدد رابط الخادم: --url "https://script.google.com/macros/s/.../exec"'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(body) {
  const t0 = performance.now();
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, retry: true, code: 'http_' + res.status }; }
    return { data, ms: performance.now() - t0 };
  } catch (e) {
    return { data: { ok: false, retry: true, code: 'network' }, ms: performance.now() - t0 };
  }
}
async function withRetry(body, attempts = 12) {
  let last, tries = 0, total = 0;
  const b = Object.assign({}, body);
  for (let i = 0; i < attempts; i++) {
    tries++;
    const { data, ms } = await post(b);
    total += ms; last = data;
    if (data.ok || !data.retry) break;
    if (data.token) b.token = data.token;
    await sleep(Math.min(700 * 1.6 ** i, 7000) * (0.6 + Math.random() * 0.8));
  }
  return { data: last, tries, ms: total };
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0) : '-'; };

console.log(`\n=== اختبار الضغط: ${COUNT} مشارك ===`);
const st = (await post({ action: 'getState' })).data;
if (!st.ok || st.state.state !== 'open') {
  console.error('لا يوجد سؤال مفتوح الآن على الخادم (الحالة: ' + (st.state && st.state.state) + ').');
  console.error('فعّل وضع الاختبار من القائمة واضبط الوقت داخل نافذة سؤال يومي جاهز، مثل 2026-11-15 19:00');
  process.exit(1);
}
const q = st.state.question;
console.log(`السؤال المفتوح: ${q.id} — ${q.text}`);
const correct = q.answerType === 'mcq' ? q.options : null;

// 1) التسجيل
console.log(`\n1) تسجيل ${COUNT} مشاركاً وهمياً...`);
const users = [];
let idx = 0, regFail = 0;
async function regWorker() {
  while (idx < COUNT) {
    const i = idx++;
    const sid = String(99000000 + i);
    const r = await withRetry({
      action: 'register', name: 'مشارك اختبار تحميل', studentId: sid,
      phone: '7' + String(1000000 + i).padStart(7, '0'), email: `t${sid}@student.squ.edu.om`, gender: i % 2 ? 'female' : 'male'
    });
    if (r.data && r.data.ok) users.push({ i, sid, pid: r.data.participant.pid });
    else { regFail++; if (regFail < 5) console.log('  فشل تسجيل', sid, r.data && r.data.code, r.data && r.data.error); }
  }
}
await Promise.all(Array.from({ length: REG_CONCURRENCY }, regWorker));
console.log(`   مسجّل: ${users.length}، فشل: ${regFail}`);

// 2) الإجابات المتزامنة
console.log(`\n2) إرسال ${users.length} إجابة ${SPREAD ? 'موزعة على ' + SPREAD + 'ms' : 'في نفس اللحظة'} + إجابات مكررة لـ ${Math.round(users.length * DUP_SHARE)} مشارك...`);
const jobs = [];
const t0 = Date.now();
users.forEach((u, k) => {
  const answer = correct ? correct[k % correct.length] : (k % 3 ? 'إجابة تجريبية' : 'اختبار');
  const delay = SPREAD ? Math.random() * SPREAD : 0;
  jobs.push(sleep(delay).then(() => withRetry({ action: 'submitAnswer', pid: u.pid, questionId: q.id, answer })).then(r => ({ kind: 'first', u, r })));
  if (k < users.length * DUP_SHARE) {
    jobs.push(sleep(delay).then(() => withRetry({ action: 'submitAnswer', pid: u.pid, questionId: q.id, answer: correct ? correct[(k + 1) % correct.length] : 'محاولة ثانية' })).then(r => ({ kind: 'dup', u, r })));
  }
});
const results = await Promise.all(jobs);
const wall = Date.now() - t0;

// 3) التحليل
const accepted = {}; const codes = {}; const lat = []; let retries = 0, failed = 0, dupRejected = 0;
results.forEach(({ u, r }) => {
  lat.push(r.ms); retries += r.tries - 1;
  const d = r.data || {};
  const c = d.ok ? (d.duplicate ? 'duplicate' : 'accepted') : (d.code || 'unknown');
  codes[c] = (codes[c] || 0) + 1;
  if (d.ok && !d.duplicate) accepted[u.sid] = (accepted[u.sid] || 0) + 1;
  if (d.ok && d.duplicate) dupRejected++;
  if (!d.ok) failed++;
});
const multi = Object.values(accepted).filter(n => n > 1).length;

console.log('\n=== النتيجة ===');
console.log('الزمن الكلي:', (wall / 1000).toFixed(1), 'ث');
console.log('النتائج حسب النوع:', codes);
console.log('إعادات المحاولة:', retries);
console.log('زمن الاستجابة (ms) — الوسيط:', pct(lat, .5), ' p95:', pct(lat, .95), ' الأقصى:', pct(lat, 1));
console.log('مشاركون قُبلت لهم أكثر من إجابة:', multi, multi === 0 ? '✅' : '❌ خطأ!');
console.log('محاولات ثانية رُفضت كتكرار:', dupRejected);
console.log('طلبات فشلت نهائياً:', failed, failed === 0 ? '✅' : '⚠️ راجع الأخطاء أعلاه');
console.log('\nالخطوة التالية: من قائمة "إدارة سراج" اختر "تحديد فائز السؤال" ثم تأكد في ورقة Answers أن لكل رقم جامعي سطراً واحداً للسؤال ' + q.id + '،');
console.log('وأن أرقام عمود rank متسلسلة بلا تكرار. ثم شغّل "حذف بيانات اختبار التحميل".');
