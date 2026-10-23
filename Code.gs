/**
 * مسابقة سراج الثقافية — الخادم (Google Apps Script)
 * مجموعة سراج — جامعة السلطان قابوس
 *
 * يُلصق هذا الملف في محرر Apps Script المرتبط بملف Google Sheets الخاص بالمسابقة.
 * كل التوقيتات بتوقيت مسقط (Asia/Muscat = UTC+4 بلا توقيت صيفي)، ويُعتمد وقت الخادم فقط.
 *
 * تصميم التحمّل (لحظة نزول السؤال قد تصل لألف طلب):
 *  - getState / init لا تقرأ من الجدول: الإعدادات والأسئلة محفوظة في CacheService وتُسخَّن كل 5 دقائق.
 *  - submitAnswer يسجّل وقت الوصول في أول سطر، ويحسب الصحة خارج القفل، ويمسك القفل لأجزاء من الثانية فقط
 *    لإضافة الإجابة إلى "طابور" مؤقت، ثم يكتب أحد الطلبات الطابور كاملاً إلى الجدول دفعة واحدة (Group commit).
 *  - إذا كان القفل مشغولاً يُعاد للمتصفح "إيصال" موقّع بوقت الوصول الأصلي، فيعيد المحاولة دون أن يخسر ترتيبه.
 */

// ============================================================
// الثوابت
// ============================================================
const TZ = 'Asia/Muscat';
const TZ_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const SHEET = {
  SETTINGS: 'Settings',
  QUESTIONS: 'Questions',
  PARTICIPANTS: 'Participants',
  ANSWERS: 'Answers',
  WINNERS: 'Winners',
  INVITEES: 'المدعوون للأمسية',
  STATS: 'إحصائيات'
};

const HEADERS = {
  Settings: ['key', 'value', 'description'],
  Questions: ['id', 'date', 'type', 'theme', 'questionText', 'answerType', 'options', 'correctAnswer',
    'acceptedAnswers', 'lectureTitle', 'lectureLocation', 'lectureTime', 'lectureCode', 'status'],
  Participants: ['participantId', 'name', 'studentId', 'phone', 'email', 'gender', 'createdAt'],
  Answers: ['answerId', 'questionId', 'participantId', 'answer', 'serverTimestamp', 'isCorrect', 'rank', 'receivedAtMuscat', 'studentId', 'dedupKey'],
  Winners: ['questionId', 'date', 'participantId', 'name', 'gender', 'answeredAt', 'approved', 'approvedBy']
};

const DEFAULT_SETTINGS = [
  ['startDate', '2026-11-15', 'أول يوم في المسابقة (yyyy-MM-dd)'],
  ['endDate', '2026-12-09', 'آخر يوم في المسابقة (yyyy-MM-dd)'],
  ['questionTime', '19:00', 'وقت طرح السؤال اليومي بتوقيت مسقط (HH:mm)'],
  ['answerWindowMinutes', '60', 'مدة فتح الإجابة بالدقائق بعد طرح السؤال'],
  ['finalEveningDate', '', 'موعد أمسية الفائزين (yyyy-MM-dd HH:mm) أو اتركه فارغاً لـ "يُعلن قريباً"'],
  ['finalEveningLocation', '', 'مكان أمسية الفائزين (اختياري)'],
  ['instagramUrl', 'https://www.instagram.com/', 'رابط حساب إنستغرام لتحدي التصوير'],
  ['videoUrl', '', 'رابط الفيديو التعريفي (يوتيوب أو ملف mp4)'],
  ['emailDomain', 'squ.edu.om', 'نطاق البريد الجامعي المقبول (يُقبل أي نطاق فرعي منه مثل student.squ.edu.om)'],
  ['siteUrl', '', 'رابط الموقع بعد النشر (يُستخدم في الإشعارات)'],
  ['oneSignalSegment', 'Total Subscriptions', 'اسم شريحة المشتركين في OneSignal'],
  ['testMode', 'FALSE', 'TRUE لتفعيل وضع الاختبار على الخادم (يزيح ساعة الخادم بالقيمة التالية)'],
  ['testOffsetMinutes', '0', 'إزاحة ساعة الخادم بالدقائق في وضع الاختبار (تُضبط من القائمة)']
];

const CACHE_CFG_KEY = 'cfg_v3';
const CACHE_WINNERS_KEY = 'winners_v3';
const CACHE_BUFFER_KEY = 'ans_buffer';
const CACHE_TTL_MAX = 21600; // 6 ساعات (الحد الأعلى في CacheService)
const LIMITS = {
  name: 80, answer: 200, code: 40,
  register: { max: 5, windowSec: 600 },
  recover: { max: 6, windowSec: 600 },
  submit: { max: 10, windowSec: 60 },
  lectureCode: { max: 8, windowSec: 300 },
  state: { max: 90, windowSec: 60 }
};
const TOKEN_TTL_MS = 10 * 60 * 1000;

// ============================================================
// نقطة الدخول
// ============================================================
function doPost(e) {
  const receivedAt = Date.now(); // أول سطر: وقت وصول الطلب الحقيقي
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'bad_json', error: 'صيغة الطلب غير صحيحة' });
  }
  try {
    const action = String(body.action || '');
    switch (action) {
      case 'init': return json_(actionInit_(body));
      case 'getState': return json_(actionGetState_(body));
      case 'register': return json_(actionRegister_(body));
      case 'recover': return json_(actionRecover_(body));
      case 'verifyLectureCode': return json_(actionVerifyLectureCode_(body));
      case 'submitAnswer': return json_(actionSubmitAnswer_(body, receivedAt));
      case 'getWinners': return json_({ ok: true, winners: getApprovedWinners_() });
      case 'getSchedule': return json_(actionGetSchedule_());
      case 'ping': return json_({ ok: true, serverNow: serverNow_() });
      default: return json_({ ok: false, code: 'unknown_action', error: 'إجراء غير معروف' });
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, code: 'server_error', error: 'حدث خطأ في الخادم، حاول مرة أخرى', retry: true });
  }
}

function doGet() {
  return json_({ ok: true, service: 'Siraj Quiz API', serverNow: serverNow_() });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// الإجراءات العامة
// ============================================================
function actionInit_(body) {
  const cfg = getConfig_();
  const now = serverNow_(cfg);
  return {
    ok: true,
    serverNow: now,
    settings: publicSettings_(cfg),
    schedule: buildSchedule_(cfg, now),
    winners: getApprovedWinners_(),
    state: buildStateFor_(cfg, now, cleanId_(body.pid))
  };
}

function actionGetState_(body) {
  const pid = cleanId_(body.pid);
  if (pid && !rateLimit_('st_' + pid, LIMITS.state)) {
    return { ok: false, code: 'rate_limited', error: 'طلبات كثيرة، انتظر قليلاً', retry: true };
  }
  const cfg = getConfig_();
  const now = serverNow_(cfg);
  return { ok: true, serverNow: now, state: buildStateFor_(cfg, now, pid) };
}

function actionGetSchedule_() {
  const cfg = getConfig_();
  const now = serverNow_(cfg);
  return { ok: true, serverNow: now, settings: publicSettings_(cfg), schedule: buildSchedule_(cfg, now) };
}

function actionRegister_(body) {
  const v = validateRegistration_(body);
  if (v.error) return { ok: false, code: 'invalid', field: v.field, error: v.error };
  const p = v.value;
  if (!rateLimit_('rg_' + p.studentId, LIMITS.register)) {
    return { ok: false, code: 'rate_limited', error: 'محاولات كثيرة، حاول بعد دقائق' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, code: 'busy', error: 'الخادم مشغول، حاول بعد لحظات', retry: true };
  try {
    const sh = sheet_(SHEET.PARTICIPANTS);
    const existing = findParticipantRow_(sh, 3, p.studentId);
    if (existing) {
      const row = existing.values;
      if (normalizePhone_(row[3]) === p.phone) {
        const user = participantFromRow_(row);
        cacheParticipant_(user);
        return { ok: true, recovered: true, participant: publicParticipant_(user) };
      }
      return {
        ok: false, code: 'exists', field: 'studentId',
        error: 'هذا الرقم الجامعي مسجّل مسبقاً. استعد حسابك برقمك الجامعي ورقم هاتفك المسجّل.'
      };
    }
    // منع تسجيل أكثر من رقم جامعي بنفس الهاتف أو البريد
    if (findParticipantRow_(sh, 4, p.phone)) {
      return { ok: false, code: 'phone_used', field: 'phone', error: 'رقم الهاتف مستخدم في تسجيل آخر. كل مشارك يسجّل برقم جامعي واحد.' };
    }
    if (findParticipantRow_(sh, 5, p.email)) {
      return { ok: false, code: 'email_used', field: 'email', error: 'البريد الجامعي مستخدم في تسجيل آخر.' };
    }
    const user = {
      participantId: Utilities.getUuid(),
      name: p.name, studentId: p.studentId, phone: p.phone, email: p.email, gender: p.gender,
      createdAt: formatMuscat_(serverNow_(), 'yyyy-MM-dd HH:mm:ss')
    };
    sh.appendRow([user.participantId, safeCell_(user.name), user.studentId, user.phone, user.email, user.gender, user.createdAt]);
    SpreadsheetApp.flush();
    cacheParticipant_(user);
    return { ok: true, participant: publicParticipant_(user) };
  } finally {
    lock.releaseLock();
  }
}

function actionRecover_(body) {
  const studentId = normalizeDigits_(String(body.studentId || '')).replace(/\s/g, '');
  const phone = normalizePhone_(body.phone);
  if (!/^\d{5,10}$/.test(studentId)) return { ok: false, code: 'invalid', field: 'studentId', error: 'الرقم الجامعي غير صحيح' };
  if (!/^[79]\d{7}$/.test(phone)) return { ok: false, code: 'invalid', field: 'phone', error: 'رقم الهاتف غير صحيح' };
  if (!rateLimit_('rc_' + studentId, LIMITS.recover)) return { ok: false, code: 'rate_limited', error: 'محاولات كثيرة، حاول بعد دقائق' };

  const found = findParticipantRow_(sheet_(SHEET.PARTICIPANTS), 3, studentId);
  if (!found || normalizePhone_(found.values[3]) !== phone) {
    return { ok: false, code: 'not_found', error: 'لم نجد حساباً بهذا الرقم الجامعي ورقم الهاتف' };
  }
  const user = participantFromRow_(found.values);
  cacheParticipant_(user);
  return { ok: true, participant: publicParticipant_(user) };
}

function actionVerifyLectureCode_(body) {
  const pid = cleanId_(body.pid);
  if (!pid) return { ok: false, code: 'not_registered', error: 'سجّل في المسابقة أولاً' };
  if (!rateLimit_('lc_' + pid, LIMITS.lectureCode)) return { ok: false, code: 'rate_limited', error: 'محاولات كثيرة، انتظر قليلاً' };
  const user = getParticipant_(pid);
  if (!user) return { ok: false, code: 'not_registered', error: 'لم نجد تسجيلك، سجّل أو استعد حسابك' };

  const cfg = getConfig_();
  const now = serverNow_(cfg);
  const day = dayForTime_(cfg, now);
  if (!day || !day.question || day.question.type !== 'lecture') return { ok: false, code: 'no_lecture', error: 'لا توجد محاضرة اليوم' };
  if (now < day.openAt) return { ok: false, code: 'not_open', error: 'لم يُفتح باب الإجابة بعد' };
  if (now >= day.closeAt) return { ok: false, code: 'closed', error: 'انتهى وقت الإجابة' };
  if (!codeMatches_(body.code, day.question.lectureCode)) return { ok: false, code: 'wrong_code', error: 'رمز المحاضرة غير صحيح' };
  return {
    ok: true,
    questionId: day.question.id,
    answerType: day.question.answerType,
    options: day.question.answerType === 'mcq' ? day.question.options : [],
    closeAt: day.closeAt
  };
}

function actionSubmitAnswer_(body, receivedAtRaw) {
  const pid = cleanId_(body.pid);
  if (!pid) return { ok: false, code: 'not_registered', error: 'سجّل في المسابقة أولاً' };

  // وقت الوصول بساعة الخادم (تُضاف إزاحة وضع الاختبار إن كان مفعّلاً)
  const cfg = getConfig_();
  receivedAtRaw = receivedAtRaw + (serverNow_(cfg) - Date.now());

  // إيصال إعادة المحاولة: يحفظ وقت الوصول الأصلي عندما كان الخادم مشغولاً
  let receivedAt = receivedAtRaw;
  let usedToken = false;
  if (body.token) {
    const t = verifyToken_(body.token);
    if (t && t.pid === pid && t.qid === String(body.questionId || '') && receivedAtRaw - t.ts < TOKEN_TTL_MS) {
      receivedAt = t.ts;
      usedToken = true;
    }
  }

  if (!usedToken && !rateLimit_('sb_' + pid, LIMITS.submit)) {
    return { ok: false, code: 'rate_limited', error: 'طلبات كثيرة، انتظر قليلاً', retry: true };
  }

  const answerRaw = String(body.answer == null ? '' : body.answer).trim();
  if (!answerRaw) return { ok: false, code: 'invalid', error: 'اكتب إجابتك أولاً' };
  if (answerRaw.length > LIMITS.answer) return { ok: false, code: 'invalid', error: 'الإجابة أطول من المسموح (200 حرف)' };

  const user = getParticipant_(pid);
  if (!user) return { ok: false, code: 'not_registered', error: 'لم نجد تسجيلك، سجّل أو استعد حسابك' };

  const day = dayForTime_(cfg, receivedAt);
  if (!day || !day.question || day.question.status !== 'ready') return { ok: false, code: 'no_question', error: 'لا يوجد سؤال مفتوح الآن' };
  const q = day.question;
  if (body.questionId && String(body.questionId) !== q.id) return { ok: false, code: 'wrong_question', error: 'هذا السؤال لم يعد مفتوحاً' };
  if (receivedAt < day.openAt) return { ok: false, code: 'not_open', error: 'لم يُفتح باب الإجابة بعد' };
  if (receivedAt >= day.closeAt) return { ok: false, code: 'closed', error: 'انتهى وقت الإجابة لهذا السؤال' };

  if (q.type === 'lecture' && !codeMatches_(body.lectureCode, q.lectureCode)) {
    return { ok: false, code: 'wrong_code', error: 'رمز المحاضرة غير صحيح' };
  }
  if (q.answerType === 'mcq') {
    const n = normalizeArabic_(answerRaw);
    if (!q.options.some(function (o) { return normalizeArabic_(o) === n; })) {
      return { ok: false, code: 'invalid', error: 'اختر أحد الخيارات المتاحة' };
    }
  }

  // ===== قاعدة ذهبية: إجابة واحدة فقط لكل رقم جامعي في كل سؤال =====
  // 1) فحص سريع في الذاكرة المؤقتة  2) فحص دائم في ورقة Answers  3) فحص نهائي داخل القفل
  const dupKey = dupKey_(q.id, user.studentId);
  const cache = CacheService.getScriptCache();
  const prev = cache.get(dupKey);
  if (prev) return { ok: true, duplicate: true, questionId: q.id, receivedAt: Number(prev) };
  const stored = findStoredAnswer_(dupKey);
  if (stored) {
    cache.put(dupKey, String(stored), CACHE_TTL_MAX);
    return { ok: true, duplicate: true, questionId: q.id, receivedAt: stored };
  }

  const isCorrect = isAnswerCorrect_(q, answerRaw); // يُحسب خارج القفل وعلى الخادم فقط
  const record = [Utilities.getUuid(), q.id, pid, safeCell_(answerRaw), receivedAt, isCorrect, '',
    formatMuscat_(receivedAt, 'yyyy-MM-dd HH:mm:ss.SSS'), user.studentId, dupKey];

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) {
    return {
      ok: false, code: 'busy', retry: true, questionId: q.id, receivedAt: receivedAt,
      token: signToken_({ pid: pid, qid: q.id, ts: receivedAt }),
      error: 'الضغط عالٍ الآن، تم حفظ وقت وصول إجابتك وسنعيد الإرسال تلقائياً'
    };
  }
  let bufferSize = 0;
  try {
    const again = cache.get(dupKey);
    if (again) return { ok: true, duplicate: true, questionId: q.id, receivedAt: Number(again) };
    const buf = readBuffer_(cache);
    const inBuf = buf.filter(function (r) { return r[9] === dupKey; })[0];
    if (inBuf) return { ok: true, duplicate: true, questionId: q.id, receivedAt: Number(inBuf[4]) };
    buf.push(record);
    bufferSize = buf.length;
    cache.putAll({ [CACHE_BUFFER_KEY]: JSON.stringify(buf), [dupKey]: String(receivedAt) }, CACHE_TTL_MAX);
  } finally {
    lock.releaseLock();
  }

  // كتابة الطابور إلى الجدول (يقوم بها طلب واحد فقط في كل لحظة)
  try {
    flushAnswerBuffer_(bufferSize > 250 ? 15000 : 0);
  } catch (err) {
    console.warn('flush deferred: ' + err);
  }
  return { ok: true, questionId: q.id, receivedAt: receivedAt };
}

// ============================================================
// الطابور المؤقت للإجابات (Group commit)
// ============================================================
function readBuffer_(cache) {
  const raw = cache.get(CACHE_BUFFER_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function dupKey_(qid, studentId) { return 'a_' + qid + '_' + studentId; }

/** يبحث في ورقة Answers عن إجابة محفوظة لنفس الرقم الجامعي ونفس السؤال، ويعيد وقتها أو 0 */
function findStoredAnswer_(dupKey) {
  const sh = sheet_(SHEET.ANSWERS);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const cell = sh.getRange(2, 10, last - 1, 1).createTextFinder(dupKey).matchEntireCell(true).findNext();
  if (!cell) return 0;
  return Number(sh.getRange(cell.getRow(), 5).getValue()) || 1;
}

/**
 * يكتب كل الإجابات المنتظرة في الطابور إلى ورقة Answers دفعة واحدة.
 * يستخدم قفل المستند (Document Lock) للكتابة، وقفل السكربت لأخذ الطابور فقط.
 */
function flushAnswerBuffer_(waitMs) {
  const docLock = LockService.getDocumentLock();
  if (!docLock.tryLock(waitMs || 0)) return 0; // طلب آخر يكتب الآن وسيأخذ إجاباتنا معه
  try {
    let total = 0;
    for (let round = 0; round < 5; round++) {
      const cache = CacheService.getScriptCache();
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) break;
      let rows;
      try {
        rows = readBuffer_(cache);
        if (rows.length) cache.remove(CACHE_BUFFER_KEY);
      } finally {
        lock.releaseLock();
      }
      if (!rows.length) break;
      try {
        const sh = sheet_(SHEET.ANSWERS);
        sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.Answers.length).setValues(rows);
        SpreadsheetApp.flush();
        total += rows.length;
      } catch (err) {
        // أعد الصفوف إلى الطابور حتى لا تضيع
        const l2 = LockService.getScriptLock();
        l2.waitLock(10000);
        try {
          const cur = readBuffer_(cache);
          cache.put(CACHE_BUFFER_KEY, JSON.stringify(rows.concat(cur)), CACHE_TTL_MAX);
        } finally {
          l2.releaseLock();
        }
        throw err;
      }
    }
    return total;
  } finally {
    docLock.releaseLock();
  }
}

// ============================================================
// الحالة والجدول الزمني
// ============================================================
function buildStateFor_(cfg, now, pid) {
  const st = computeState_(cfg, now);
  if (pid && st.questionId) {
    const user = getParticipant_(pid);
    if (user) {
      const at = CacheService.getScriptCache().get(dupKey_(st.questionId, user.studentId));
      if (at) st.myAnswer = { receivedAt: Number(at) };
    }
  }
  return st;
}

/** يحسب حالة اليوم حسب وقت الخادم. لا يرسل نص السؤال قبل موعده، ولا يرسل الإجابة الصحيحة أبداً. */
function computeState_(cfg, now) {
  const days = questionDays_(cfg);
  const winMs = cfg.settings.answerWindowMinutes * 60000;
  if (!days.length) return { state: 'ended' };
  const last = days[days.length - 1];
  if (now >= last.closeAt) return { state: 'ended', finalEvening: finalEvening_(cfg) };

  const today = muscatDateStr_(now);
  const day = days.filter(function (d) { return d.date === today; })[0];
  const next = days.filter(function (d) { return d.openAt > now; })[0] || null;
  const nextInfo = next ? dayPublic_(next) : null;

  if (!day) {
    if (now < days[0].openAt && today < days[0].date) {
      return { state: 'before', beforeStart: true, next: nextInfo, windowMinutes: winMs / 60000 };
    }
    return { state: 'off', next: nextInfo };
  }

  const q = day.question;
  const base = { day: dayPublic_(day), questionId: q ? q.id : null, openAt: day.openAt, closeAt: day.closeAt };

  if (q && q.type === 'lecture') {
    const phase = now < day.openAt ? 'before' : (now < day.closeAt ? 'open' : 'closed');
    if (phase === 'closed') return Object.assign(base, { state: 'closed', next: nextAfter_(days, day) });
    return Object.assign(base, {
      state: 'lecture', phase: phase,
      lecture: { title: q.lectureTitle, location: q.lectureLocation, time: q.lectureTime || cfg.settings.questionTime }
    });
  }

  if (now < day.openAt) return Object.assign(base, { state: 'before', next: dayPublic_(day) });
  if (now >= day.closeAt) return Object.assign(base, { state: 'closed', next: nextAfter_(days, day) });
  if (!q || q.status !== 'ready' || !q.questionText) return Object.assign(base, { state: 'pending' });

  return Object.assign(base, {
    state: 'open',
    question: {
      id: q.id,
      text: q.questionText,
      type: q.type,
      theme: q.theme,
      answerType: q.answerType,
      options: q.answerType === 'mcq' ? q.options : []
    }
  });
}

function nextAfter_(days, day) {
  const i = days.indexOf(day);
  return days[i + 1] ? dayPublic_(days[i + 1]) : null;
}

function dayPublic_(d) {
  const q = d.question;
  return {
    n: d.n, date: d.date, dow: d.dow, openAt: d.openAt, closeAt: d.closeAt,
    type: q ? q.type : 'daily',
    theme: q && q.type === 'themed' ? q.theme : '',
    lectureTitle: q && q.type === 'lecture' ? q.lectureTitle : '',
    lectureLocation: q && q.type === 'lecture' ? q.lectureLocation : '',
    lectureTime: q && q.type === 'lecture' ? (q.lectureTime || '') : ''
  };
}

function buildSchedule_(cfg, now) {
  const today = muscatDateStr_(now);
  return questionDays_(cfg).map(function (d) {
    const p = dayPublic_(d);
    p.status = d.date < today || now >= d.closeAt ? 'past' : (d.date === today ? 'today' : 'upcoming');
    return p;
  });
}

/** أيام الأسئلة: من الأحد إلى الأربعاء بين startDate و endDate، مرقّمة 1..N */
function questionDays_(cfg) {
  const s = cfg.settings;
  const winMs = s.answerWindowMinutes * 60000;
  const byDate = {};
  cfg.questions.forEach(function (q) { if (q.date && !byDate[q.date]) byDate[q.date] = q; });
  const out = [];
  let t = muscatMidnightMs_(s.startDate);
  const end = muscatMidnightMs_(s.endDate);
  let n = 0;
  while (t <= end && out.length < 200) {
    const date = muscatDateStr_(t);
    const dow = new Date(t + TZ_OFFSET_MS).getUTCDay(); // 0 = الأحد
    if (dow >= 0 && dow <= 3) {
      n++;
      const q = byDate[date] || null;
      const time = q && q.type === 'lecture' && isTime_(q.lectureTime) ? q.lectureTime : s.questionTime;
      const openAt = muscatMs_(date, time);
      out.push({ n: n, date: date, dow: dow, question: q, openAt: openAt, closeAt: openAt + winMs });
    }
    t += DAY_MS;
  }
  return out;
}

function dayForTime_(cfg, ms) {
  const date = muscatDateStr_(ms);
  return questionDays_(cfg).filter(function (d) { return d.date === date; })[0] || null;
}

function publicSettings_(cfg) {
  const s = cfg.settings;
  return {
    startDate: s.startDate, endDate: s.endDate, questionTime: s.questionTime,
    answerWindowMinutes: s.answerWindowMinutes, instagramUrl: s.instagramUrl, videoUrl: s.videoUrl,
    finalEvening: finalEvening_(cfg), siteUrl: s.siteUrl, emailDomain: s.emailDomain
  };
}

function finalEvening_(cfg) {
  const raw = String(cfg.settings.finalEveningDate || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?$/);
  if (!m) return { text: raw, location: cfg.settings.finalEveningLocation };
  return { at: muscatMs_(m[1], m[2] || '19:00'), date: m[1], time: m[2] || '', location: cfg.settings.finalEveningLocation };
}

// ============================================================
// الإعدادات والأسئلة (مع ذاكرة مؤقتة)
// ============================================================
let CFG_MEMO_ = null;

function getConfig_() {
  if (CFG_MEMO_) return CFG_MEMO_;
  const cache = CacheService.getScriptCache();
  const raw = cache.get(CACHE_CFG_KEY);
  if (raw) {
    try { CFG_MEMO_ = JSON.parse(raw); return CFG_MEMO_; } catch (e) { /* يُعاد البناء */ }
  }
  CFG_MEMO_ = loadConfigFromSheets_();
  cache.put(CACHE_CFG_KEY, JSON.stringify(CFG_MEMO_), 900);
  return CFG_MEMO_;
}

function loadConfigFromSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settings = {};
  DEFAULT_SETTINGS.forEach(function (r) { settings[r[0]] = r[1]; });
  const sSh = ss.getSheetByName(SHEET.SETTINGS);
  if (sSh && sSh.getLastRow() > 1) {
    sSh.getRange(2, 1, sSh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      const k = String(r[0] || '').trim();
      if (k) settings[k] = cellToString_(r[1], k);
    });
  }
  settings.answerWindowMinutes = Math.max(1, Math.min(24 * 60, Number(settings.answerWindowMinutes) || 60));
  settings.questionTime = isTime_(settings.questionTime) ? padTime_(settings.questionTime) : '19:00';
  settings.testMode = String(settings.testMode).toUpperCase() === 'TRUE';
  settings.testOffsetMinutes = Number(settings.testOffsetMinutes) || 0;
  settings.emailDomain = String(settings.emailDomain || 'squ.edu.om').toLowerCase().replace(/^@/, '');

  const questions = [];
  const qSh = ss.getSheetByName(SHEET.QUESTIONS);
  if (qSh && qSh.getLastRow() > 1) {
    const h = HEADERS.Questions;
    qSh.getRange(2, 1, qSh.getLastRow() - 1, h.length).getValues().forEach(function (r) {
      const o = {};
      h.forEach(function (k, i) { o[k] = cellToString_(r[i], k); });
      if (!o.id || !o.date) return;
      o.id = String(o.id).trim();
      o.type = ['daily', 'lecture', 'themed'].indexOf(String(o.type).trim()) >= 0 ? String(o.type).trim() : 'daily';
      o.answerType = String(o.answerType).trim() === 'mcq' ? 'mcq' : 'text';
      o.options = splitList_(o.options);
      o.acceptedAnswers = splitList_(o.acceptedAnswers);
      o.status = String(o.status).trim() === 'ready' ? 'ready' : 'draft';
      o.lectureTime = isTime_(o.lectureTime) ? padTime_(o.lectureTime) : '';
      questions.push(o);
    });
  }
  return { settings: settings, questions: questions, builtAt: Date.now() };
}

function clearCaches_() {
  CFG_MEMO_ = null;
  CacheService.getScriptCache().removeAll([CACHE_CFG_KEY, CACHE_WINNERS_KEY]);
}

/** يُستدعى تلقائياً عند تعديل الجدول يدوياً، فيُحدّث الموقع خلال ثوانٍ */
function onEdit(e) {
  try {
    const name = e && e.range ? e.range.getSheet().getName() : '';
    if (name === SHEET.SETTINGS || name === SHEET.QUESTIONS || name === SHEET.WINNERS) clearCaches_();
  } catch (err) { /* تجاهل */ }
}

/** مشغّل كل 5 دقائق: يسخّن الذاكرة المؤقتة ويكتب أي إجابات متبقية في الطابور */
function warmUp() {
  clearCaches_();
  getConfig_();
  getApprovedWinners_();
  flushAnswerBuffer_(20000);
}

function serverNow_(cfg) {
  const c = cfg || getConfig_();
  return Date.now() + (c.settings.testMode ? c.settings.testOffsetMinutes * 60000 : 0);
}

// ============================================================
// المشاركون
// ============================================================
function validateRegistration_(b) {
  const name = String(b.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 6 || name.length > LIMITS.name) return { field: 'name', error: 'اكتب اسمك الثلاثي' };
  if (!/^[؀-ۿa-zA-Z\s'\-]+$/.test(name)) return { field: 'name', error: 'الاسم يجب أن يحتوي على حروف فقط' };
  const parts = name.split(' ').filter(function (w) { return w.length >= 2; });
  if (parts.length < 3) return { field: 'name', error: 'اكتب اسمك الثلاثي (ثلاثة أسماء على الأقل)' };

  const studentId = normalizeDigits_(String(b.studentId || '')).replace(/\s/g, '');
  if (!/^\d{5,10}$/.test(studentId)) return { field: 'studentId', error: 'الرقم الجامعي يتكون من أرقام فقط (5 إلى 10 أرقام)' };

  const phone = normalizePhone_(b.phone);
  if (!/^[79]\d{7}$/.test(phone)) return { field: 'phone', error: 'رقم الهاتف العُماني يتكون من 8 أرقام ويبدأ بـ 7 أو 9' };

  const email = String(b.email || '').trim().toLowerCase();
  const domain = getConfig_().settings.emailDomain;
  if (email.length > 100 || !/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) return { field: 'email', error: 'البريد الإلكتروني غير صحيح' };
  const host = email.split('@')[1];
  if (domain && host !== domain && !host.endsWith('.' + domain)) return { field: 'email', error: 'استخدم بريدك الجامعي (@' + domain + ')' };

  const gender = String(b.gender || '');
  if (gender !== 'male' && gender !== 'female') return { field: 'gender', error: 'اختر الفئة: طالب أو طالبة' };

  return { value: { name: name, studentId: studentId, phone: phone, email: email, gender: gender } };
}

function findParticipantRow_(sh, col, value) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const cell = sh.getRange(2, col, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  if (!cell) return null;
  const rowIdx = cell.getRow();
  return { row: rowIdx, values: sh.getRange(rowIdx, 1, 1, HEADERS.Participants.length).getValues()[0] };
}

function participantFromRow_(r) {
  return {
    participantId: String(r[0]), name: String(r[1]).replace(/^'/, ''), studentId: String(r[2]), phone: String(r[3]),
    email: String(r[4]), gender: String(r[5]), createdAt: String(r[6])
  };
}

function publicParticipant_(u) {
  return { pid: u.participantId, name: u.name, studentId: u.studentId, gender: u.gender };
}

function cacheParticipant_(u) {
  CacheService.getScriptCache().put('p_' + u.participantId,
    JSON.stringify({ participantId: u.participantId, name: u.name, gender: u.gender, studentId: u.studentId }), CACHE_TTL_MAX);
}

function getParticipant_(pid) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get('p_' + pid);
  if (raw) return JSON.parse(raw);
  const found = findParticipantRow_(sheet_(SHEET.PARTICIPANTS), 1, pid);
  if (!found) return null;
  const u = participantFromRow_(found.values);
  cacheParticipant_(u);
  return u;
}

/** يسخّن بيانات كل المشاركين في الذاكرة المؤقتة قبل موعد السؤال (حتى لا يبحث الخادم في الجدول لحظة الضغط) */
function warmParticipants() {
  const sh = sheet_(SHEET.PARTICIPANTS);
  if (sh.getLastRow() < 2) return;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.Participants.length).getValues();
  const cache = CacheService.getScriptCache();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = {};
    rows.slice(i, i + 500).forEach(function (r) {
      if (!r[0]) return;
      const u = participantFromRow_(r);
      chunk['p_' + u.participantId] = JSON.stringify({ participantId: u.participantId, name: u.name, gender: u.gender, studentId: u.studentId });
    });
    cache.putAll(chunk, CACHE_TTL_MAX);
  }
}

// ============================================================
// مطابقة الإجابات والتطبيع العربي
// ============================================================
function normalizeDigits_(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); })
    .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); });
}

function normalizeArabic_(s) {
  let t = normalizeDigits_(s).toLowerCase();
  t = t.replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, ''); // التشكيل
  t = t.replace(/ـ/g, '');                                       // التطويل
  t = t.replace(/[آأإٱ]/g, 'ا');             // آ أ إ ٱ ← ا
  t = t.replace(/ى/g, 'ي');                                 // ى ← ي
  t = t.replace(/ة/g, 'ه');                                 // ة ← ه
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');                            // علامات الترقيم
  return t.replace(/\s+/g, ' ').trim();
}

function isAnswerCorrect_(q, answer) {
  const a = normalizeArabic_(answer);
  if (!a) return false;
  const accepted = [q.correctAnswer].concat(q.answerType === 'text' ? q.acceptedAnswers : [])
    .map(normalizeArabic_).filter(Boolean);
  return accepted.indexOf(a) >= 0;
}

function codeMatches_(given, expected) {
  const e = normalizeArabic_(expected).replace(/\s/g, '');
  const g = normalizeArabic_(String(given || '').slice(0, LIMITS.code)).replace(/\s/g, '');
  return !!e && e === g;
}

function normalizePhone_(p) {
  let d = normalizeDigits_(String(p == null ? '' : p)).replace(/\D/g, '');
  if (d.length > 8 && d.indexOf('00968') === 0) d = d.slice(5);
  else if (d.length > 8 && d.indexOf('968') === 0) d = d.slice(3);
  return d;
}

// ============================================================
// الفائزون
// ============================================================
function getApprovedWinners_() {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(CACHE_WINNERS_KEY);
  if (raw) return JSON.parse(raw);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.WINNERS);
  const cfg = getConfig_();
  const numByQid = {};
  questionDays_(cfg).forEach(function (d) { if (d.question) numByQid[d.question.id] = d.n; });
  let list = [];
  if (sh && sh.getLastRow() > 1) {
    list = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.Winners.length).getValues()
      .filter(function (r) { return r[0] && (r[6] === true || String(r[6]).toUpperCase() === 'TRUE'); })
      .map(function (r) {
        return {
          questionId: String(r[0]), n: numByQid[String(r[0])] || null, date: cellToString_(r[1], 'date'),
          name: String(r[3]).replace(/^'/, ''), gender: String(r[4])
        };
      })
      .sort(function (a, b) { return (a.n || 99) - (b.n || 99); });
  }
  cache.put(CACHE_WINNERS_KEY, JSON.stringify(list), 300);
  return list;
}

/**
 * يحسب أسرع إجابة صحيحة لسؤال، ويكتب الترتيب في Answers، ويضع الفائز في Winners بقيمة approved=FALSE.
 * لا يستبدل فائزاً معتمداً إلا إذا كان force=true.
 */
function determineWinnerFor_(qid, force) {
  flushAnswerBuffer_(20000);
  const cfg = getConfig_();
  const q = cfg.questions.filter(function (x) { return x.id === String(qid); })[0];
  if (!q) throw new Error('لا يوجد سؤال بالمعرّف ' + qid);

  const aSh = sheet_(SHEET.ANSWERS);
  const last = aSh.getLastRow();
  const data = last > 1 ? aSh.getRange(2, 1, last - 1, HEADERS.Answers.length).getValues() : [];

  // أول إجابة فقط لكل رقم جامعي (احتياط إضافي: أي سطر مكرر يُتجاهل في الحساب)
  const firstByPid = {};
  data.forEach(function (r, i) {
    if (String(r[1]) !== q.id) return;
    const who = String(r[8] || r[2]);
    const ts = Number(r[4]);
    if (!firstByPid[who] || ts < firstByPid[who].ts) firstByPid[who] = { i: i, ts: ts, pid: String(r[2]), correct: r[5] === true || String(r[5]).toUpperCase() === 'TRUE' };
  });
  const correct = Object.keys(firstByPid).map(function (k) { return firstByPid[k]; })
    .filter(function (x) { return x.correct; })
    .sort(function (a, b) { return a.ts - b.ts; });

  // تحديث عمود الترتيب
  const rankCol = data.map(function (r) { return [String(r[1]) === q.id ? '' : r[6]]; });
  correct.forEach(function (x, idx) { rankCol[x.i][0] = idx + 1; });
  if (data.length) aSh.getRange(2, 7, data.length, 1).setValues(rankCol);

  const result = {
    question: q,
    totalAnswers: Object.keys(firstByPid).length,
    correctCount: correct.length,
    top: correct.slice(0, 10).map(function (x) { return { pid: x.pid, ts: x.ts, participant: getParticipant_(x.pid) }; }),
    winner: null
  };
  if (!correct.length) return result;

  const w = correct[0];
  const user = getParticipant_(w.pid);
  const wSh = sheet_(SHEET.WINNERS);
  const wLast = wSh.getLastRow();
  const wData = wLast > 1 ? wSh.getRange(2, 1, wLast - 1, HEADERS.Winners.length).getValues() : [];
  const idx = wData.findIndex(function (r) { return String(r[0]) === q.id; });
  const row = [q.id, q.date, w.pid, safeCell_(user ? user.name : ''), user ? user.gender : '',
    formatMuscat_(w.ts, 'yyyy-MM-dd HH:mm:ss.SSS'), false, ''];
  if (idx >= 0) {
    const approved = wData[idx][6] === true || String(wData[idx][6]).toUpperCase() === 'TRUE';
    if (!approved || force) wSh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  } else {
    wSh.appendRow(row);
  }
  clearCaches_();
  result.winner = { pid: w.pid, ts: w.ts, participant: user };
  return result;
}

/** مشغّل كل 10 دقائق: بعد إغلاق نافذة أي سؤال يُحسب فائزه تلقائياً (بانتظار اعتماد اللجنة) */
function autoFinalize() {
  flushAnswerBuffer_(20000);
  const cfg = getConfig_();
  const now = serverNow_(cfg);
  const props = PropertiesService.getScriptProperties();
  questionDays_(cfg).forEach(function (d) {
    if (!d.question || d.question.status !== 'ready') return;
    if (now < d.closeAt + 60000) return;
    const key = 'finalized_' + d.question.id;
    if (props.getProperty(key)) return;
    determineWinnerFor_(d.question.id, false);
    props.setProperty(key, String(Date.now()));
  });
}

// ============================================================
// الإشعارات عبر OneSignal (اختياري)
// ============================================================
/** مشغّل يومي ظهراً: يجدول إشعار "السؤال بعد 10 دقائق" في OneSignal لأيام الأسئلة */
function scheduleTodayPush() {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty('ONESIGNAL_APP_ID');
  const key = props.getProperty('ONESIGNAL_REST_KEY');
  if (!appId || !key) return;
  const cfg = getConfig_();
  const now = serverNow_(cfg);
  const day = dayForTime_(cfg, now);
  if (!day) return;
  const sendAt = day.openAt - 10 * 60000;
  if (sendAt <= Date.now()) return;
  const flag = 'push_' + day.date;
  if (props.getProperty(flag)) return;

  const q = day.question;
  let ar = 'سؤال اليوم بعد 10 دقائق.. جهّز نفسك، أسرع إجابة صحيحة تفوز!';
  if (q && q.type === 'lecture') {
    ar = 'سؤال اليوم يُطرح حصرياً في المحاضرة: ' + (q.lectureTitle || '') + (q.lectureLocation ? ' – ' + q.lectureLocation : '');
  } else if (q && q.type === 'themed' && q.theme) {
    ar = 'سؤال اليوم عن "' + q.theme + '" بعد 10 دقائق.. جهّز نفسك!';
  }
  const payload = {
    app_id: appId,
    included_segments: [cfg.settings.oneSignalSegment || 'Total Subscriptions'],
    headings: { en: 'مسابقة سراج الثقافية', ar: 'مسابقة سراج الثقافية' },
    contents: { en: ar, ar: ar },
    url: cfg.settings.siteUrl || undefined,
    send_after: new Date(sendAt).toUTCString()
  };
  const res = UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Key ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  console.log('OneSignal ' + res.getResponseCode() + ': ' + res.getContentText());
  if (res.getResponseCode() < 300) props.setProperty(flag, '1');
}

/** يُنشئ كل المشغّلات الزمنية المطلوبة (شغّله مرة واحدة من القائمة) */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['warmUp', 'autoFinalize', 'scheduleTodayPush', 'warmParticipants'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmUp').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('autoFinalize').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('scheduleTodayPush').timeBased().atHour(12).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('warmParticipants').timeBased().atHour(18).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ui_().alert('تم تفعيل المشغّلات: تسخين الذاكرة كل 5 دقائق، تحديد الفائز تلقائياً كل 10 دقائق، جدولة الإشعار يومياً، وتسخين بيانات المشاركين قبل السؤال.');
}

// ============================================================
// قائمة "إدارة سراج" داخل Google Sheets
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('إدارة سراج')
    .addItem('🏆 تحديد فائز السؤال', 'menuDetermineWinner')
    .addItem('✅ اعتماد الفائز', 'menuApproveWinner')
    .addItem('📄 إنشاء تقرير اليوم', 'menuDailyReport')
    .addItem('🎟️ قائمة المدعوين للأمسية', 'menuInvitees')
    .addItem('📊 إحصائيات', 'menuStats')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('الإعداد والاختبار')
      .addItem('إنشاء الأوراق والأعمدة', 'setupSheets')
      .addItem('إضافة البيانات التجريبية (3 أسئلة)', 'seedSampleData')
      .addItem('تفعيل المشغّلات الزمنية', 'installTriggers')
      .addItem('ضبط وقت الاختبار (TEST_MODE)', 'menuSetTestTime')
      .addItem('إيقاف وضع الاختبار', 'menuStopTestMode')
      .addItem('حذف بيانات اختبار التحميل', 'menuCleanupLoadTest')
      .addItem('تحديث الموقع فوراً (مسح الذاكرة المؤقتة)', 'menuClearCache'))
    .addToUi();
}

// عند التشغيل من محرر Apps Script لا تتوفر واجهة الشيت، فتُكتب الرسائل في سجل التنفيذ بدلاً من النافذة
function ui_() {
  try { return SpreadsheetApp.getUi(); } catch (e) {
    return {
      alert: function () { console.log([].slice.call(arguments).filter(function (a) { return typeof a === 'string'; }).join(' — ')); return 'OK'; },
      prompt: function () { return { getSelectedButton: function () { return 'CANCEL'; }, getResponseText: function () { return ''; } }; },
      ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
      Button: { OK: 'OK', YES: 'YES', NO: 'NO', CANCEL: 'CANCEL' }
    };
  }
}

function promptQuestionId_(title) {
  const cfg = getConfig_();
  const now = serverNow_(cfg);
  const days = questionDays_(cfg).filter(function (d) { return d.question && d.openAt <= now; });
  const suggested = days.length ? days[days.length - 1].question.id : (cfg.questions[0] ? cfg.questions[0].id : '');
  const res = ui_().prompt(title, 'اكتب رقم السؤال (id) من ورقة Questions.\nالمقترح: ' + suggested + ' (اتركه فارغاً لاستخدامه)', ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return null;
  return String(res.getResponseText() || suggested).trim();
}

function menuDetermineWinner() {
  const qid = promptQuestionId_('تحديد فائز السؤال');
  if (!qid) return;
  clearCaches_();
  const r = determineWinnerFor_(qid, false);
  if (!r.winner) {
    ui_().alert('لا توجد إجابة صحيحة للسؤال ' + qid + '.\nعدد المشاركين: ' + r.totalAnswers);
    return;
  }
  const p = r.winner.participant || {};
  ui_().alert('فائز السؤال ' + qid + ':\n' + (p.name || r.winner.pid) + '\nوقت الإجابة: ' + formatMuscat_(r.winner.ts, 'HH:mm:ss.SSS') +
    '\n\nالمشاركون: ' + r.totalAnswers + ' — الصحيحة: ' + r.correctCount +
    '\n\nكُتب في ورقة Winners بقيمة approved = FALSE. استخدم "اعتماد الفائز" لإظهاره في الموقع.');
}

function menuApproveWinner() {
  const qid = promptQuestionId_('اعتماد الفائز');
  if (!qid) return;
  const sh = sheet_(SHEET.WINNERS);
  const last = sh.getLastRow();
  const data = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.Winners.length).getValues() : [];
  const idx = data.findIndex(function (r) { return String(r[0]) === qid; });
  if (idx < 0) { ui_().alert('لا يوجد فائز محدد للسؤال ' + qid + '. استخدم "تحديد فائز السؤال" أولاً.'); return; }
  const ok = ui_().alert('اعتماد الفائز', 'اعتماد "' + String(data[idx][3]).replace(/^'/, '') + '" فائزاً بالسؤال ' + qid + '؟ سيظهر اسمه في الموقع.', ui_().ButtonSet.YES_NO);
  if (ok !== ui_().Button.YES) return;
  const by = Session.getActiveUser().getEmail() || 'اللجنة الثقافية';
  sh.getRange(idx + 2, 7, 1, 2).setValues([[true, by]]);
  clearCaches_();
  ui_().alert('تم الاعتماد ✅ سيظهر الفائز في الموقع خلال دقيقة.');
}

function menuDailyReport() {
  const qid = promptQuestionId_('إنشاء تقرير اليوم');
  if (!qid) return;
  clearCaches_();
  const r = determineWinnerFor_(qid, false);
  const q = r.question;
  const cfg = getConfig_();
  const day = questionDays_(cfg).filter(function (d) { return d.question && d.question.id === q.id; })[0];

  const doc = DocumentApp.create('تقرير مسابقة سراج — السؤال ' + (day ? day.n : q.id) + ' — ' + q.date);
  const body = doc.getBody();
  body.setAttributes({ [DocumentApp.Attribute.FONT_FAMILY]: 'Arial' });
  const rtl = function (p) { try { p.setLeftToRight(false); } catch (e) { } p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT); return p; };

  rtl(body.appendParagraph('تقرير مسابقة سراج الثقافية').setHeading(DocumentApp.ParagraphHeading.TITLE));
  rtl(body.appendParagraph('السؤال رقم ' + (day ? day.n : '-') + ' — بتاريخ ' + q.date + ' — النوع: ' + typeLabel_(q.type) + (q.theme ? ' (' + q.theme + ')' : '')));
  rtl(body.appendParagraph('السؤال').setHeading(DocumentApp.ParagraphHeading.HEADING2));
  rtl(body.appendParagraph(q.questionText || '(يُطرح في المحاضرة)'));
  if (q.answerType === 'mcq' && q.options.length) rtl(body.appendParagraph('الخيارات: ' + q.options.join(' | ')));
  rtl(body.appendParagraph('الإجابة الصحيحة').setHeading(DocumentApp.ParagraphHeading.HEADING2));
  rtl(body.appendParagraph(q.correctAnswer + (q.acceptedAnswers.length ? '  (بدائل مقبولة: ' + q.acceptedAnswers.join('، ') + ')' : '')));
  if (q.type === 'lecture') rtl(body.appendParagraph('المحاضرة: ' + q.lectureTitle + ' — ' + q.lectureLocation + ' — ' + (q.lectureTime || cfg.settings.questionTime)));

  rtl(body.appendParagraph('الأرقام').setHeading(DocumentApp.ParagraphHeading.HEADING2));
  rtl(body.appendParagraph('عدد المشاركين في السؤال: ' + r.totalAnswers));
  rtl(body.appendParagraph('عدد الإجابات الصحيحة: ' + r.correctCount));
  rtl(body.appendParagraph('نسبة الصحيحة: ' + (r.totalAnswers ? Math.round(r.correctCount * 100 / r.totalAnswers) : 0) + '%'));

  rtl(body.appendParagraph('أسرع 10 إجابات صحيحة').setHeading(DocumentApp.ParagraphHeading.HEADING2));
  if (r.top.length) {
    const rows = [['الترتيب', 'الاسم', 'الرقم الجامعي', 'وقت الاستلام', 'الفارق عن الطرح']];
    r.top.forEach(function (x, i) {
      const p = x.participant || {};
      const diff = day ? ((x.ts - day.openAt) / 1000).toFixed(3) + ' ث' : '';
      rows.push([String(i + 1), p.name || x.pid, p.studentId || '', formatMuscat_(x.ts, 'HH:mm:ss.SSS'), diff]);
    });
    body.appendTable(rows);
  } else {
    rtl(body.appendParagraph('لا توجد إجابات صحيحة.'));
  }

  rtl(body.appendParagraph('الفائز').setHeading(DocumentApp.ParagraphHeading.HEADING2));
  if (r.winner) {
    const p = r.winner.participant || {};
    rtl(body.appendParagraph((p.name || r.winner.pid) + ' — ' + (p.gender === 'female' ? 'طالبة' : 'طالب') + ' — ' + formatMuscat_(r.winner.ts, 'HH:mm:ss.SSS')));
    rtl(body.appendParagraph('حالة الاعتماد: بانتظار اعتماد اللجنة الثقافية (أو معتمد إن سبق اعتماده).'));
  } else {
    rtl(body.appendParagraph('لا يوجد فائز لهذا السؤال.'));
  }
  rtl(body.appendParagraph('أُنشئ التقرير في ' + formatMuscat_(Date.now(), 'yyyy-MM-dd HH:mm') + ' بتوقيت مسقط.'));
  doc.saveAndClose();

  const folderName = 'تقارير مسابقة سراج';
  const it = DriveApp.getFoldersByName(folderName);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  ui_().alert('تم إنشاء التقرير في مجلد "' + folderName + '":\n' + doc.getUrl());
}

function menuInvitees() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const wSh = sheet_(SHEET.WINNERS);
  const last = wSh.getLastRow();
  const winners = last > 1 ? wSh.getRange(2, 1, last - 1, HEADERS.Winners.length).getValues()
    .filter(function (r) { return r[0] && (r[6] === true || String(r[6]).toUpperCase() === 'TRUE'); }) : [];
  const pSh = sheet_(SHEET.PARTICIPANTS);
  const pRows = pSh.getLastRow() > 1 ? pSh.getRange(2, 1, pSh.getLastRow() - 1, HEADERS.Participants.length).getValues() : [];
  const byPid = {};
  pRows.forEach(function (r) { byPid[String(r[0])] = r; });
  const cfg = getConfig_();
  const numByQid = {};
  questionDays_(cfg).forEach(function (d) { if (d.question) numByQid[d.question.id] = d.n; });

  // فائز واحد قد يفوز بأكثر من سؤال: يُدعى مرة واحدة مع ذكر أسئلته
  const map = {};
  winners.forEach(function (w) {
    const pid = String(w[2]);
    const p = byPid[pid] || [];
    if (!map[pid]) map[pid] = { name: String(p[1] || w[3]).replace(/^'/, ''), studentId: p[2] || '', phone: p[3] || '', email: p[4] || '', gender: (p[5] || w[4]) === 'female' ? 'طالبة' : 'طالب', qs: [] };
    map[pid].qs.push((numByQid[String(w[0])] || w[0]) + ' (' + cellToString_(w[1], 'date') + ')');
  });
  const out = [['#', 'الاسم', 'الرقم الجامعي', 'الهاتف', 'البريد', 'الفئة', 'الأسئلة التي فاز بها']];
  Object.keys(map).forEach(function (k, i) {
    const m = map[k];
    out.push([i + 1, m.name, m.studentId, m.phone, m.email, m.gender, m.qs.join('، ')]);
  });
  let sh = ss.getSheetByName(SHEET.INVITEES);
  if (!sh) sh = ss.insertSheet(SHEET.INVITEES);
  sh.clear();
  sh.setRightToLeft(true);
  sh.getRange(1, 1, out.length, out[0].length).setNumberFormat('@').setValues(out);
  sh.getRange(1, 1, 1, out[0].length).setFontWeight('bold').setBackground('#1E4C9A').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, out[0].length);
  ss.setActiveSheet(sh);
  ui_().alert('قائمة المدعوين جاهزة: ' + (out.length - 1) + ' فائز/ة معتمد/ة.');
}

function menuStats() {
  flushAnswerBuffer_(20000);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pSh = sheet_(SHEET.PARTICIPANTS);
  const pRows = pSh.getLastRow() > 1 ? pSh.getRange(2, 1, pSh.getLastRow() - 1, HEADERS.Participants.length).getValues().filter(function (r) { return r[0]; }) : [];
  const male = pRows.filter(function (r) { return r[5] === 'male'; }).length;
  const female = pRows.filter(function (r) { return r[5] === 'female'; }).length;
  const total = pRows.length;

  const aSh = sheet_(SHEET.ANSWERS);
  const aRows = aSh.getLastRow() > 1 ? aSh.getRange(2, 1, aSh.getLastRow() - 1, HEADERS.Answers.length).getValues() : [];
  const cfg = getConfig_();
  const days = questionDays_(cfg);

  const out = [['المؤشر', 'القيمة', '', '']];
  out.push(['إجمالي المشاركين المسجلين', total, '', '']);
  out.push(['الطلاب', male, total ? Math.round(male * 100 / total) + '%' : '0%', '']);
  out.push(['الطالبات', female, total ? Math.round(female * 100 / total) + '%' : '0%', '']);
  out.push(['إجمالي الإجابات', aRows.length, '', '']);
  out.push(['', '', '', '']);
  out.push(['السؤال', 'التاريخ', 'عدد الإجابات', 'الصحيحة']);
  days.forEach(function (d) {
    const qid = d.question ? d.question.id : null;
    const rows = qid ? aRows.filter(function (r) { return String(r[1]) === qid; }) : [];
    const correct = rows.filter(function (r) { return r[5] === true || String(r[5]).toUpperCase() === 'TRUE'; }).length;
    out.push(['السؤال ' + d.n + (qid ? ' (id ' + qid + ')' : ''), d.date, rows.length, correct]);
  });
  let sh = ss.getSheetByName(SHEET.STATS);
  if (!sh) sh = ss.insertSheet(SHEET.STATS);
  sh.clear();
  sh.setRightToLeft(true);
  sh.getRange(1, 1, out.length, 4).setValues(out);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground('#1E4C9A').setFontColor('#FFFFFF');
  sh.getRange(7, 1, 1, 4).setFontWeight('bold').setBackground('#F5EFE3');
  sh.autoResizeColumns(1, 4);
  ss.setActiveSheet(sh);
  ui_().alert('الإحصائيات محدّثة في ورقة "' + SHEET.STATS + '".');
}

function menuSetTestTime() {
  const res = ui_().prompt('ضبط وقت الاختبار',
    'اكتب الوقت الذي تريد أن "يعيشه" الخادم بتوقيت مسقط بصيغة yyyy-MM-dd HH:mm\nمثال: 2026-11-15 18:59 (قبل السؤال الأول بدقيقة)',
    ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return;
  const m = String(res.getResponseText()).trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/);
  if (!m) { ui_().alert('الصيغة غير صحيحة'); return; }
  const offsetMin = Math.round((muscatMs_(m[1], m[2]) - Date.now()) / 60000);
  setSetting_('testMode', 'TRUE');
  setSetting_('testOffsetMinutes', String(offsetMin));
  clearCaches_();
  ui_().alert('وضع الاختبار مفعّل ✅\nساعة الخادم الآن تقارب: ' + m[1] + ' ' + m[2] + ' وتستمر بالجريان.\nلا تنسَ إيقافه قبل الإطلاق.');
}

function menuStopTestMode() {
  setSetting_('testMode', 'FALSE');
  setSetting_('testOffsetMinutes', '0');
  clearCaches_();
  ui_().alert('تم إيقاف وضع الاختبار. الخادم يعمل الآن بالوقت الحقيقي.');
}

function menuCleanupLoadTest() {
  const ok = ui_().alert('حذف بيانات اختبار التحميل', 'سيُحذف كل مشارك رقمه الجامعي يبدأ بـ 99000 مع إجاباته وفوزه. متابعة؟', ui_().ButtonSet.YES_NO);
  if (ok !== ui_().Button.YES) return;
  flushAnswerBuffer_(20000);
  const pSh = sheet_(SHEET.PARTICIPANTS);
  const pRows = pSh.getLastRow() > 1 ? pSh.getRange(2, 1, pSh.getLastRow() - 1, HEADERS.Participants.length).getValues() : [];
  const testPids = {};
  pRows.forEach(function (r) { if (String(r[2]).indexOf('99000') === 0) testPids[String(r[0])] = true; });
  const removed = { p: 0, a: 0, w: 0 };
  [[SHEET.PARTICIPANTS, 0, 'p'], [SHEET.ANSWERS, 2, 'a'], [SHEET.WINNERS, 2, 'w']].forEach(function (cfg) {
    const sh = sheet_(cfg[0]);
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const width = HEADERS[cfg[0]].length;
    const rows = sh.getRange(2, 1, n, width).getValues();
    const keep = rows.filter(function (r) { return !testPids[String(r[cfg[1]])]; });
    removed[cfg[2]] = rows.length - keep.length;
    if (removed[cfg[2]] === 0) return;
    sh.getRange(2, 1, n, width).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, width).setValues(keep);
  });
  PropertiesService.getScriptProperties().getKeys().forEach(function (k) {
    if (k.indexOf('finalized_') === 0) PropertiesService.getScriptProperties().deleteProperty(k);
  });
  clearCaches_();
  ui_().alert('تم الحذف: ' + removed.p + ' مشارك، ' + removed.a + ' إجابة، ' + removed.w + ' فائز.\nملاحظة: سجلات منع التكرار في الذاكرة المؤقتة تنتهي تلقائياً خلال 6 ساعات.');
}

function menuClearCache() {
  clearCaches_();
  ui_().alert('تم. سيقرأ الموقع أحدث الإعدادات والأسئلة الآن.');
}

// ============================================================
// إنشاء الأوراق والبيانات التجريبية
// ============================================================
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const h = HEADERS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#1E4C9A').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.setRightToLeft(name === SHEET.SETTINGS);
  });
  // أعمدة نصية حتى لا تحوّلها Google Sheets إلى تواريخ أو أرقام
  sheet_(SHEET.SETTINGS).getRange('B:B').setNumberFormat('@');
  sheet_(SHEET.QUESTIONS).getRange('A:N').setNumberFormat('@');
  sheet_(SHEET.PARTICIPANTS).getRange('A:G').setNumberFormat('@');
  sheet_(SHEET.ANSWERS).getRange('A:D').setNumberFormat('@');
  sheet_(SHEET.ANSWERS).getRange('E:E').setNumberFormat('0');
  sheet_(SHEET.ANSWERS).getRange('H:J').setNumberFormat('@');
  sheet_(SHEET.WINNERS).getRange('A:F').setNumberFormat('@');
  sheet_(SHEET.WINNERS).getRange('H:H').setNumberFormat('@');

  const sSh = sheet_(SHEET.SETTINGS);
  const existing = sSh.getLastRow() > 1 ? sSh.getRange(2, 1, sSh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const missing = DEFAULT_SETTINGS.filter(function (r) { return existing.indexOf(r[0]) < 0; });
  if (missing.length) sSh.getRange(sSh.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  sSh.autoResizeColumns(1, 3);

  // قوائم منسدلة لتقليل الأخطاء
  const qSh = sheet_(SHEET.QUESTIONS);
  const dv = function (list) { return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build(); };
  qSh.getRange('C2:C200').setDataValidation(dv(['daily', 'lecture', 'themed']));
  qSh.getRange('F2:F200').setDataValidation(dv(['mcq', 'text']));
  qSh.getRange('N2:N200').setDataValidation(dv(['draft', 'ready']));
  sheet_(SHEET.WINNERS).getRange('G2:G500').insertCheckboxes();

  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('الورقة1') || ss.getSheetByName('ورقة1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  if (!PropertiesService.getScriptProperties().getProperty('HMAC_SECRET')) {
    PropertiesService.getScriptProperties().setProperty('HMAC_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  clearCaches_();
  try { ui_().alert('تم إنشاء الأوراق والأعمدة ✅'); } catch (e) { /* عند التشغيل من المحرر */ }
}

function seedSampleData() {
  setupSheets();
  const sh = sheet_(SHEET.QUESTIONS);
  const rows = [
    ['1', '2026-11-15', 'daily', '', 'كم عدد محافظات سلطنة عُمان؟', 'mcq', '9|10|11|12', '11', '', '', '', '', '', 'ready'],
    ['2', '2026-11-16', 'lecture', '', 'من مؤلف كتاب «تحفة الأعيان بسيرة أهل عُمان»؟', 'text', '', 'نور الدين السالمي',
      'السالمي|عبدالله بن حميد السالمي|الإمام نور الدين السالمي|عبد الله السالمي', 'محاضرة: كنوز المخطوطات العُمانية',
      'قاعة المحاضرات الكبرى – كلية التربية', '19:00', 'سراج2026', 'ready'],
    ['3', '2026-11-17', 'themed', 'التراث العُماني', 'ما اسم القلعة العُمانية التي أُدرجت في قائمة اليونسكو للتراث العالمي عام 1987م؟', 'text', '',
      'قلعة بهلاء', 'بهلاء|بهلا|قلعه بهلا|حصن بهلاء', '', '', '', '', 'ready']
  ];
  const last = sh.getLastRow();
  const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const toAdd = rows.filter(function (r) { return ids.indexOf(r[0]) < 0; });
  if (toAdd.length) sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, rows[0].length).setValues(toAdd);
  sh.autoResizeColumns(1, 6);
  clearCaches_();
  try { ui_().alert('أُضيفت ' + toAdd.length + ' أسئلة تجريبية (يومي، محاضرة، موضوعي).\nرمز المحاضرة التجريبي: سراج2026'); } catch (e) { }
}

function setSetting_(key, value) {
  const sh = sheet_(SHEET.SETTINGS);
  const last = sh.getLastRow();
  const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  const i = keys.indexOf(key);
  if (i >= 0) sh.getRange(i + 2, 2).setValue(value);
  else sh.appendRow([key, value, '']);
}

// ============================================================
// أدوات مساعدة
// ============================================================
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('الورقة "' + name + '" غير موجودة. شغّل "إنشاء الأوراق والأعمدة" من قائمة إدارة سراج.');
  return sh;
}

function muscatDateStr_(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function muscatMidnightMs_(dateStr) { return muscatMs_(dateStr, '00:00'); }

function muscatMs_(dateStr, hhmm) {
  const p = String(dateStr).split('-').map(Number);
  const t = String(hhmm || '00:00').split(':').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2], t[0] || 0, t[1] || 0) - TZ_OFFSET_MS;
}

function formatMuscat_(ms, pattern) { return Utilities.formatDate(new Date(ms), TZ, pattern); }

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function isTime_(s) { return /^\d{1,2}:\d{2}$/.test(String(s || '').trim()); }

function padTime_(s) {
  const t = String(s).trim().split(':');
  return pad2_(Number(t[0])) + ':' + t[1];
}

function splitList_(s) {
  return String(s || '').split('|').map(function (x) { return x.trim(); }).filter(Boolean);
}

/** يحوّل قيمة الخلية إلى نص (التواريخ إلى yyyy-MM-dd والأوقات إلى HH:mm) */
function cellToString_(v, key) {
  if (v instanceof Date) {
    if (/time/i.test(key || '')) return Utilities.formatDate(v, TZ, 'HH:mm');
    if (key === 'finalEveningDate') return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return v == null ? '' : String(v);
}

function cleanId_(s) {
  const v = String(s || '').trim();
  return /^[0-9a-f\-]{36}$/i.test(v) ? v.toLowerCase() : '';
}

/** يمنع حقن الصيغ في Google Sheets */
function safeCell_(s) {
  const v = String(s == null ? '' : s);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function typeLabel_(t) { return t === 'lecture' ? 'محاضرة' : (t === 'themed' ? 'موضوعي' : 'يومي'); }

/** حد معدل تقريبي باستخدام CacheService */
function rateLimit_(key, rule) {
  const cache = CacheService.getScriptCache();
  const bucket = Math.floor(Date.now() / (rule.windowSec * 1000));
  const k = 'rl_' + key + '_' + bucket;
  const n = Number(cache.get(k) || 0);
  if (n >= rule.max) return false;
  cache.put(k, String(n + 1), rule.windowSec + 5);
  return true;
}

function hmacSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('HMAC_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('HMAC_SECRET', s); }
  return s;
}

function signToken_(obj) {
  const data = Utilities.base64EncodeWebSafe(JSON.stringify(obj));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(data, hmacSecret_()));
  return data + '.' + sig;
}

function verifyToken_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], hmacSecret_()));
  if (sig !== parts[1]) return null;
  try {
    const obj = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    return obj && obj.pid && obj.qid && obj.ts ? obj : null;
  } catch (e) {
    return null;
  }
}
