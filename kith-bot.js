/* KITH Bot — enquiries in, messages out.
 *
 * TWO WAYS A JOB STARTS
 *   Online  — Instagram, TikTok, email, the website, WhatsApp. The lead lands
 *             in the inbox, an auto-reply asks for name, phone and reg, and
 *             once those three are in, the bot carries on over WhatsApp.
 *   By hand — a phone call or someone walking in. Whoever takes it types one
 *             line. The bot sends "we've got your enquiry" and asks for
 *             anything missing.
 * Either way it ends up as a job in the CRM. Nobody types a full intake.
 *
 * HOW A MESSAGE GOES OUT
 *   WhatsApp first. If the customer has no WhatsApp, a text instead.
 *   Email is the extra for confirmations, never the main route.
 * Nothing here talks to WhatsApp, Twilio or email directly: it writes the
 * message into the outbox and the sender empties it once those accounts are
 * connected. Until then every message sits queued and can be sent by hand in
 * one tap — nothing is lost and nothing is sent twice.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KITHBot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0';
  const SHOP = 'KITH Cars';

  // Where an enquiry came from. `reply` says whether we can answer in the
  // same place, `auto` whether an auto-reply can fire there.
  const CHANNELS = {
    whatsapp:  { label: 'WhatsApp',  reply: true,  auto: true,  send: true },
    sms:       { label: 'Text',      reply: true,  auto: true,  send: true },
    instagram: { label: 'Instagram', reply: true,  auto: true,  send: false },
    facebook:  { label: 'Facebook',  reply: true,  auto: true,  send: false },
    tiktok:    { label: 'TikTok',    reply: false, auto: false, send: false },
    email:     { label: 'Email',     reply: true,  auto: true,  send: true },
    website:   { label: 'Website',   reply: false, auto: true,  send: false },
    phone:     { label: 'Phone call', reply: false, auto: false, send: false },
    walkin:    { label: 'Walk-in',   reply: false, auto: false, send: false }
  };
  const channelLabel = c => (CHANNELS[c] || { label: c || 'Other' }).label;
  // Someone typed it in rather than it arriving on its own
  const BY_HAND = ['phone', 'walkin'];
  const isByHand = c => BY_HAND.includes(c);

  // The three things that get a lead into the bot's list
  const NEEDED = ['name', 'phone', 'reg'];
  // What the quote goes out on, in order. Email is not in here on purpose.
  const QUOTE_ROUTE = ['whatsapp', 'sms'];

  const LEAD_STATES = {
    new: 'Needs their details',
    bot: 'Bot is asking',
    ready: 'Ready for the workshop',
    job: 'In the CRM',
    junk: 'Not a job'
  };

  const str = v => String(v == null ? '' : v).trim();
  const clone = o => JSON.parse(JSON.stringify(o));
  function ts(d) {
    return (d || new Date()).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── Phone numbers, regs and names ───────────────────────────────
  // UK mobile/landline in the form WhatsApp and Twilio both want: 447700900123
  function intlPhone(p) {
    const d = str(p).replace(/[^\d+]/g, '');
    if (!d) return '';
    if (d.startsWith('+')) return d.slice(1).replace(/\D/g, '');
    if (d.startsWith('00')) return d.slice(2);
    if (d.startsWith('0')) return '44' + d.slice(1);
    if (d.startsWith('44')) return d;
    return d;
  }
  const looksLikePhone = p => { const d = intlPhone(p); return d.length >= 10 && d.length <= 15; };
  const looksLikeEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(e));
  // A UK plate, however it was typed
  const PLATE = [
    /^[A-Z]{2}\d{2}[A-Z]{3}$/,      // current  AB12CDE
    /^[A-Z]\d{1,3}[A-Z]{3}$/,       // prefix   A123BCD
    /^[A-Z]{3}\d{1,3}[A-Z]$/,       // suffix   ABC123D
    /^[A-Z]{1,3}\d{1,4}$/,          // dateless ABC1234
    /^[A-Z]{1,3}\d{1,4}[A-Z]{1,2}$/ // Northern Ireland and the like
  ];
  function cleanReg(r) {
    const s = str(r).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length < 4 || s.length > 8) return '';
    if (!/\d/.test(s)) return '';                 // every plate has a number in it
    return PLATE.some(re => re.test(s)) ? s : '';
  }
  function firstName(n) {
    const t = str(n).replace(/^(mr|mrs|miss|ms|dr|sir)\.?\s+/i, '').split(/\s+/)[0];
    return t || 'there';
  }

  // One line typed by whoever took the call, pulled apart.
  //   "Mr Jones 07700 900123 AB12 CDE clutch slipping"
  function parseLine(line) {
    let s = str(line);
    const out = { name: '', phone: '', reg: '', what: '' };
    const email = s.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
    if (email) { out.email = email[0]; s = s.replace(email[0], ' '); }
    const phone = s.match(/(\+?\d[\d\s().-]{8,}\d)/);
    if (phone && looksLikePhone(phone[1])) { out.phone = phone[1].replace(/[^\d+]/g, ''); s = s.replace(phone[1], ' '); }
    // reg: two letters, two digits, three letters (with or without the space), or an older plate
    const reg = s.match(/\b([A-Za-z]{2}\s?\d{2}\s?[A-Za-z]{3})\b/) || s.match(/\b([A-Za-z]\d{1,3}\s?[A-Za-z]{3})\b/) || s.match(/\b([A-Za-z]{3}\s?\d{1,3}[A-Za-z]?)\b/);
    if (reg && cleanReg(reg[1])) { out.reg = cleanReg(reg[1]); s = s.replace(reg[1], ' '); }
    s = s.replace(/\s+/g, ' ').trim();
    // a name is the words before the work, if they look like a name
    const m = s.match(/^((?:mr|mrs|miss|ms|dr)\.?\s+)?([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,2})\b/);
    if (m) { out.name = (m[1] ? m[1].trim() + ' ' : '') + m[2]; s = s.slice(m[0].length).trim(); }
    out.what = s.replace(/^[-–—,:;.\s]+/, '').trim();
    return out;
  }

  // ── Leads ───────────────────────────────────────────────────────
  function makeLead(o, by, now) {
    now = now || new Date();
    const channel = CHANNELS[o && o.channel] ? o.channel : 'whatsapp';
    const parsed = o.line ? parseLine(o.line) : {};
    const lead = {
      id: 'LD' + now.getTime() + (o.idSuffix || ''),
      channel, handle: str(o.handle),
      name: str(o.name || parsed.name), phone: str(o.phone || parsed.phone), reg: cleanReg(o.reg || parsed.reg),
      email: str(o.email || parsed.email), what: str(o.what || parsed.what),
      state: 'new', messages: [], jobId: '', notes: str(o.notes),
      by: by || '', at: ts(now), t: now.getTime()
    };
    if (!lead.handle) lead.handle = lead.phone || lead.email || '';
    lead.state = leadState(lead);
    return lead;
  }
  const hasAll = l => NEEDED.every(k => k === 'reg' ? !!cleanReg(l && l[k]) : !!str(l && l[k]));
  const missing = l => NEEDED.filter(k => k === 'reg' ? !cleanReg(l && l[k]) : !str(l && l[k]));
  function leadState(l) {
    if (!l) return 'new';
    if (l.state === 'junk' || l.jobId) return l.jobId ? 'job' : 'junk';
    if (!hasAll(l)) return 'new';
    return str(l.what) ? 'ready' : 'bot';
  }
  // Same person messaging twice shouldn't become two leads
  function findLead(list, o) {
    const ph = intlPhone(o.phone), h = str(o.handle).toLowerCase(), em = str(o.email).toLowerCase(), rg = cleanReg(o.reg);
    return (list || []).find(l => l && l.state !== 'job' && (
      (ph && intlPhone(l.phone) === ph) ||
      (h && str(l.handle).toLowerCase() === h && l.channel === o.channel) ||
      (em && str(l.email).toLowerCase() === em) ||
      (rg && cleanReg(l.reg) === rg))) || null;
  }
  function addMessage(lead, m, now) {
    const out = clone(lead);
    out.messages = (out.messages || []).concat([Object.assign({ at: ts(now), t: (now || new Date()).getTime() }, m)]);
    if (out.messages.length > 100) out.messages = out.messages.slice(-100);
    return out;
  }
  // Details the customer sent back
  function updateLead(lead, fields, by, now) {
    const out = clone(lead);
    ['name', 'phone', 'reg', 'email', 'what', 'notes'].forEach(k => {
      if (fields[k] == null || !str(fields[k])) return;
      out[k] = k === 'reg' ? (cleanReg(fields[k]) || out.reg) : str(fields[k]);
    });
    out.state = leadState(out);
    out.messages = out.messages || [];
    out.updatedBy = by || out.updatedBy; out.updatedAt = ts(now);
    return out;
  }

  // ── What the bot says ───────────────────────────────────────────
  const sign = t => t + '\n\n— ' + SHOP;
  const MESSAGES = {
    // fired where they messaged us, to get the three things
    capture: l => sign('Hi' + (str(l.name) ? ' ' + firstName(l.name) : '') + ', thanks for getting in touch with ' + SHOP + '.\n\n' +
      'So we can look at it properly, can you send:\n• Your name\n• Your mobile number\n• Your registration\n\n' +
      'Our service adviser will pick it up with you on WhatsApp.'),
    // first WhatsApp from the bot once we have the three
    opener: l => sign('Hi ' + firstName(l.name) + ', ' + SHOP + ' here — we\'ve got your enquiry about ' + (str(l.reg) ? l.reg : 'your car') + '.\n\n' +
      'Can you tell us a bit more about what it\'s doing? Any noises, warning lights or when it started all help.'),
    // someone rang or walked in
    tookByPhone: l => sign('Hi ' + firstName(l.name) + ', ' + SHOP + ' here — thanks for your call about ' + (str(l.reg) || 'your car') + '.\n\n' +
      (str(l.what) ? 'We\'ve got it down as: ' + l.what + '.\n\n' : '') +
      'We\'re putting an estimate together and will come back to you shortly.'),
    // the job needs more before it can be priced
    moreDetail: (l, ask) => sign('Thanks ' + firstName(l.name) + '. To price ' + (str(l.reg) || 'it') + ' properly we need a bit more:\n\n' +
      (ask || '• What exactly is it doing, and when?\n• Any warning lights on the dash?\n• A photo or a short video if you can') +
      '\n\nWhatever you\'ve got helps.'),
    chaseDetails: l => sign('Hi ' + firstName(l.name) + ', just a nudge from ' + SHOP + ' — we still need a few details on ' + (str(l.reg) || 'your car') +
      ' before we can price it up. Whenever you get a minute.'),
    // the quote itself, sent the moment it is approved
    quote: j => sign('Hi ' + firstName(j.name) + ', your quote from ' + SHOP + ' is ready.\n\n' +
      vehicle(j) + '\n' + (str(j.work) ? j.work + '\n' : '') + '\nTotal: £' + money(j.quote) + ' including VAT.\n\n' +
      'Happy to go ahead? Reply YES and we\'ll get you booked in. Any questions, just ask.'),
    // and the same thing in one line, for a text message
    quoteSms: j => 'KITH Cars: your quote for ' + vehicle(j) + ' is £' + money(j.quote) + ' inc VAT' +
      (str(j.work) ? ' (' + shorten(j.work, 60) + ')' : '') + '. Reply YES to book in, or call us on 020 8123 4567.',
    confirm: j => sign('Booked in ✅\n\n' + vehicle(j) + '\n' + (j.bookedFor ? 'Date: ' + j.bookedFor + '\n' : '') +
      (str(j.work) ? 'Work: ' + j.work + '\n' : '') + 'Total: £' + money(j.quote) + ' inc VAT\n\nSee you then.')
  };
  function vehicle(j) {
    const v = [j.make, j.model].filter(x => str(x) && !/^[-–—]|n\/?a/i.test(str(x))).join(' ');
    return (v ? v + ' ' : '') + (str(j.reg) ? '(' + j.reg + ')' : '');
  }
  const money = n => (parseFloat(n) || 0).toFixed(2);
  const shorten = (s, n) => str(s).length > n ? str(s).slice(0, n - 1) + '…' : str(s);

  // ── The outbox ──────────────────────────────────────────────────
  // One message, with the channels to try in order. The sender walks the
  // list, stops at the first that works, and writes back what happened.
  function queue(o, by, now) {
    now = now || new Date();
    const route = (o.route || QUOTE_ROUTE).filter(c => CHANNELS[c] && CHANNELS[c].send);
    const to = intlPhone(o.phone);
    if (!route.length) throw new Error('No way to send this — add a phone number or an email.');
    if (!to && !looksLikeEmail(o.email)) throw new Error('No phone number or email to send to.');
    return {
      id: 'MSG' + now.getTime() + (o.idSuffix || ''),
      kind: o.kind || 'message', jobId: o.jobId || '', leadId: o.leadId || '',
      to, email: looksLikeEmail(o.email) ? str(o.email) : '',
      route, text: str(o.text), smsText: str(o.smsText || o.text),
      status: 'queued', tries: 0, sentVia: '', error: '',
      by: by || '', at: ts(now), t: now.getTime()
    };
  }
  // What the sender can actually use right now
  function sendableOn(msg, live) {
    const on = live || {};
    return (msg.route || []).filter(c => on[c] && (c === 'email' ? !!msg.email : !!msg.to));
  }
  const isQueued = m => m && m.status === 'queued';
  function markSent(msg, via, now) {
    const out = clone(msg);
    out.status = 'sent'; out.sentVia = via; out.sentAt = ts(now); out.tries = (out.tries || 0) + 1;
    return out;
  }
  function markFailed(msg, why, now) {
    const out = clone(msg);
    out.tries = (out.tries || 0) + 1;
    out.error = str(why); out.lastTry = ts(now);
    if (out.tries >= 5) out.status = 'stuck';       // stop trying; it shows up to be sent by hand
    return out;
  }
  // The one-tap fallback while nothing is connected
  const waLink = m => 'https://wa.me/' + intlPhone(m.to) + '?text=' + encodeURIComponent(m.text || '');
  const smsLink = m => 'sms:+' + intlPhone(m.to) + '?&body=' + encodeURIComponent(m.smsText || m.text || '');
  const mailLink = m => 'mailto:' + (m.email || '') + '?subject=' + encodeURIComponent(m.subject || (SHOP + ' — your quote')) + '&body=' + encodeURIComponent(m.text || '');

  // ── Approving a quote sends it ──────────────────────────────────
  // No adviser step: the approval is the send. The chase clock starts here,
  // and any reply from the customer takes the job out of the chase.
  function approveAndSend(job, by, now) {
    const j = clone(job);
    const amt = parseFloat(j.quote) || parseFloat(j.finalEst) || 0;
    if (!amt) throw new Error('No quote on this job yet.');
    if (!str(j.phone)) throw new Error('No phone number on this job — add one before approving.');
    now = now || new Date();
    j.signedOff = true; j.signedOffAt = ts(now); j.signedOffBy = by || ''; j.signedOffAmount = amt;
    if (!parseFloat(j.quote)) j.quote = amt;
    j.signOffNote = '';
    j.stage = 'contacted'; j.stageAt = now.getTime();
    j.quoteSentVia = 'auto';
    const msg = queue({ kind: 'quote', jobId: j.id, phone: j.phone, email: j.email,
      text: MESSAGES.quote(j), smsText: MESSAGES.quoteSms(j), route: QUOTE_ROUTE }, by, now);
    j.msgOutbox = (j.msgOutbox || []).concat([msg]);
    j.log = (j.log || []).concat([{ t: ts(now), s: '✓ Approved at £' + amt.toFixed(2) + ' — quote sent to the customer (WhatsApp, text if no WhatsApp)' + (by ? ' [' + by + ']' : '') }]);
    return { job: j, message: msg };
  }
  // The customer replied — stop chasing, whatever they said
  function customerReplied(job, text, by, now) {
    const j = clone(job);
    j.lastReplyAt = ts(now); j.lastReply = str(text);
    j.chasePaused = true;
    j.log = (j.log || []).concat([{ t: ts(now), s: '💬 Customer replied' + (str(text) ? ': ' + shorten(text, 120) : '') + (by ? ' [' + by + ']' : '') }]);
    return j;
  }

  // ── Turning a lead into a job ───────────────────────────────────
  function leadToJob(lead, by, now) {
    now = now || new Date();
    if (!hasAll(lead)) throw new Error('Still needs: ' + missing(lead).map(k => k === 'reg' ? 'the reg' : 'a ' + k).join(' and ') + '.');
    const id = 'J' + now.getTime() + (lead.idSuffix || '');
    return {
      id, reg: cleanReg(lead.reg), name: str(lead.name), phone: str(lead.phone), email: str(lead.email),
      make: '', model: '', work: str(lead.what), stage: 'intake', stageAt: now.getTime(),
      source: channelLabel(lead.channel), leadId: lead.id, enquiredAt: lead.at,
      parts: [], payments: [],
      log: [{ t: ts(now), s: 'Taken in from ' + channelLabel(lead.channel) + (lead.handle ? ' (' + lead.handle + ')' : '') + (by ? ' [' + by + ']' : '') }]
        .concat((lead.messages || []).filter(m => m.dir === 'in').slice(-5).map(m => ({ t: m.at, s: '💬 ' + channelLabel(m.channel || lead.channel) + ': ' + shorten(m.text, 200) })))
    };
  }

  return {
    VERSION, SHOP, CHANNELS, channelLabel, isByHand, NEEDED, QUOTE_ROUTE, LEAD_STATES, MESSAGES,
    intlPhone, looksLikePhone, looksLikeEmail, cleanReg, firstName, parseLine, vehicle,
    makeLead, leadState, hasAll, missing, findLead, addMessage, updateLead, leadToJob,
    queue, sendableOn, isQueued, markSent, markFailed, waLink, smsLink, mailLink,
    approveAndSend, customerReplied, ts
  };
});
