# KITH Sales — setup notes

**kith-sales.html** sits beside the live inbox. It has four tabs:

- **Pipeline:** every lead from cold to booked. Contacted jobs show their chase progress and the full message history.
- **Customers:** everyone from CRM jobs and the inbox, with MOT and service due dates, and whether you may market to them by email, text or WhatsApp.
- **Campaigns:** five automatic reminders (MOT, service, review, win-back, lapsed), plus one-off campaigns by text, email or WhatsApp.
- **B2B:** fleets and trade, including the CRM's paper-pad B2B board, spreadsheet imports and cold-email sequences.

It **reads** the live inbox's leads (the `__leads__` row) but never changes them. Triage, the Brain's range and "send to CRM" stay with the live inbox.

## What's in this change

| File | What |
|---|---|
| `kith-sales.html` | The Sales page. Inbox has a **Sales ↗** button to it. |
| `kith-sales-ui.js` | Its screens |
| `kith-sales.js` | The rules: who a customer is, who may be messaged, what goes out and when. Also runs in Apps Script. |
| `kith-range.js`, `kith-flow.js` | Helpers the rules use (kinds of work, CRM stage names) |
| `kith-feeds.gs` | **Apps Script only.** Sends campaigns every 10 minutes. Brings Gmail, Instagram, Facebook and texts in **through inbox-ingest**, so they're triaged like every other lead. |
| `kith-sales.test.js` | 115 checks on the rules: `node kith-sales.test.js` |
| `kith-inbox.html` | **Sales ↗** button. Fix: triage no longer auto-replies to someone who sends STOP or UNSUBSCRIBE. Fix: the rapid-fire range message said "020 XXXX XXXX"; it now says 020 4629 9469. |
| `kith-bot.js`, `kith-website-form.html` | Fix: wrong or placeholder phone numbers replaced with 020 4629 9469 |

## Setup

### 1. Supabase: one table
In the SQL Editor, run:
```sql
create table if not exists kith_sales (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create index if not exists kith_sales_type on kith_sales ((data->>'type'), (data->>'status'));
create index if not exists kith_sales_to on kith_sales ((data->>'to'));
```
Then open **kith-sales.html** and sign in. Pipeline, Customers and B2B work straight away.

### 2. The sender (Google Apps Script)
1. Sign in to Google as **kithcarsinfo@gmail.com** (the script sends from and reads that Gmail).
2. Go to script.google.com, click **New project**, and name it **KITH Feeds**.
3. Create three files, in this order: `kith-range` (paste `kith-range.js`), `kith-sales` (paste `kith-sales.js`), `kith-feeds` (paste `kith-feeds.gs`).
4. Go to **⚙ Project Settings → Script Properties** and add:
   - `SUPABASE_URL` = `https://mxyrxyhvjndgjqupgstu.supabase.co`
   - `SUPABASE_KEY` = the **service_role** key (Supabase → Project Settings → API). It goes here and nowhere else.
   - `FEEDS_SECRET` = a long pass phrase you make up
   - `OWN_EMAILS` = your own email addresses, separated by commas
5. Run `setup()` and allow the permissions. Run `testLead()`: a "Test Customer" should appear in the live inbox. Mark it as junk.
6. Click **Deploy → New deployment → Web app**. Set it to execute as **Me**, with access for **Anyone**. Copy the `/exec` address.

✅ Within 10 minutes, **Sales → Campaigns** says **Sender is running**.

### 3. Texts (optional): Twilio
1. In Script Properties, add `TWILIO_SID`, `TWILIO_TOKEN` and `TWILIO_FROM` (`+447…`).
2. On the Twilio number, set **A message comes in** to Webhook (HTTP POST): `<your /exec address>?k=<FEEDS_SECRET>`.
3. Run `setup()` again.

### 4. Instagram and Facebook
1. In the Meta app, add **Messenger** and **Instagram**.
2. Set the webhook to the `/exec` address and the verify token to `META_VERIFY_TOKEN`, then subscribe to `messages`.
3. In Script Properties, add `META_VERIFY_TOKEN`, `META_PAGE_TOKEN` (with `pages_messaging` and `instagram_manage_messages`) and `META_IDS` (your Page id and Instagram account id).

### 5. WhatsApp campaigns
WhatsApp marketing needs templates Meta has approved. Create them in WhatsApp Manager (category: Marketing) and type each template's name into the campaign or reminder. Campaigns go out through the same WhatsApp relay as the CRM.

**The website form is already handled.** `kith-website-form.html` posts straight to inbox-ingest, so the sender doesn't need to be involved.

## Who may be messaged
- **Opt-outs:** anyone who replies STOP or UNSUBSCRIBE, by any channel, is opted out of everything.
- **Email and text:** past customers and anyone who asked for a price (UK soft opt-in), with an opt-out on every message.
- **AA, warranty and insurance customers:** they need a yes first, because their details came from someone else.
- **WhatsApp marketing:** only to people who said yes.
- **Cold B2B:** email only, to limited companies.

**Sending limits:** Monday to Friday 9am to 7pm, and Saturday 9am to 5pm. At most one marketing message per person per week. 90 emails a day, because Gmail allows 100 and 10 are kept for replies. All five reminders start switched off. Only the director login can launch campaigns or switch reminders on.
