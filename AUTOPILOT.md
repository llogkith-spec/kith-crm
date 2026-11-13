# KITH Autopilot — WhatsApp that sends itself

**What it does:** every minute, with nobody logged in, it:

1. **Triages new inbox messages.** Retail mechanical enquiries get their instant price range. Everyone else gets a short "we've got your enquiry" reply, and the right person gets a WhatsApp ping. Anything ambiguous waits for Logan.
2. **Sends the instant range** for retail jobs typed in on the intake form.
3. **Sends everything waiting in the outbox.** That includes the quote you approve at sign-off, which goes with the TechMan PDF attached.

**What it never does:**
- Send a range to trade, AA, warranty, insurance, fleet, comebacks, walk-ins, BMG, MOT-only, tyre-fit-only or recovery jobs.
- Send a range on a "diagnostic first" (safety) job, or when the Brain raises a safety concern.
- Send anything older than 24 hours.
- Reply twice: while it's running, the inbox page stands down.

The code is in `kith-autopilot.gs`, with 56 checks in `kith-autopilot.test.js`.

---

## The one switch

It's the Script property **`AUTOPILOT`** in the Apps Script project:

| Value | What happens |
|---|---|
| `test` *(default)* | It triages and works out ranges, but **nothing goes to a customer**. Job logs say "Autopilot (test mode) would send the range £X–£Y". |
| `on` | It sends for real. The inbox then shows "WhatsApp is live". |
| `off` | It does nothing. |

The inbox shows a banner telling you which mode it's in and when it last ran. If it ever stops, the banner goes red and the inbox page takes over again.

---

## Setting it up (one time)

### 1. Meta: the WhatsApp Business account (Logan)

1. Go to **business.facebook.com** and use the KITH business account (the one with the Facebook and Instagram pages).
2. Go to **developers.facebook.com**, then **My Apps → Create app**. Choose type **Business** and add the **WhatsApp** product.
3. Under **WhatsApp → API Setup → Add phone number**:
   - Use a number that is **not** on the WhatsApp app right now. Moving the current business number over takes it off the WhatsApp Business app.
   - Verify it by SMS or call, and set the display name to **KITH Cars**.
4. Copy the **Phone number ID** shown on that page. This is your `PHONE_ID`.
5. Make the access token:
   - Go to **Business settings → Users → System users → Add**, with the Admin role.
   - Choose **Assign assets** and give it the app and the WhatsApp account with full control.
   - Choose **Generate token**, pick the app, set expiry to **Never**, and tick `whatsapp_business_messaging` and `whatsapp_business_management`.
   - That token is your `META_TOKEN`.
6. In **WhatsApp Manager → Payment settings**, add a card. Meta charges a small amount per template message. Check the current UK rate there.
7. Do **Business verification** under Business settings → Security centre. Until it's done, Meta limits how many new customers you can message a day.

### 2. Submit the message templates (WhatsApp Manager → Message templates)

Settings for every template:
- Language: **English (UK)**
- Category: **Utility**
- Use the name exactly as written below.

A template is only used outside Meta's 24-hour window, for example for a website lead who hasn't messaged you on WhatsApp. Approval usually takes minutes to a day.

| Name | Body (copy exactly) | Sample values |
|---|---|---|
| `kith_price_range` | Hi {{1}}, thanks for getting in touch with KITH Cars. Jobs like this usually come to between £{{2}} and £{{3}} including VAT. If that works for you, just reply YES and we'll put together your exact quote. | Sam · 180 · 250 |
| `kith_estimate` | **Header: Document.** Body: Hi {{1}}, here is your estimate from KITH Cars for your {{2}}: {{3}}. Reply YES to book in, or reply with any questions. | Sam · Ford Focus (AB12CDE) · £412.50 including VAT |
| `kith_quote_ready` | Hi {{1}}, your quote from KITH Cars for your {{2}} is £{{3}} including VAT. Reply YES to book in, or reply with any questions. | Sam · Ford Focus (AB12CDE) · 412.50 |
| `kith_enquiry_received` | Hi {{1}}, thanks for getting in touch with KITH Cars. We've got your enquiry and one of the team will reply shortly. | Sam |
| `kith_staff_alert` | New enquiry for you in the KITH inbox: {{1}}. Open the inbox to pick it up. | WEBSITE · Sam · 07700 900123 · front brakes grinding |
| `kith_chase` | Hi {{1}}, KITH Cars here. Just checking our quote for your {{2}} came through OK. Reply YES to book in, or reply with any questions. | Sam · Ford Focus (AB12CDE) |
| `kith_job_assigned` | New job assigned to you in the KITH CRM: {{1}}, {{2}}. Open the CRM to start it. | AB12CDE · Front pads and discs |

Meta rejects templates that start or end with a {{ }} variable, so keep the wording as written.

### 3. The relay and the autopilot (one Apps Script project)

1. Go to **script.google.com → New project** and name it *KITH WhatsApp*.
2. Paste in `kith-relay.gs`. Then add a second file with **+ → Script**, name it `kith-autopilot`, and paste in `kith-autopilot.gs`.
3. Under **Project Settings → Script properties**, add:

   | Property | Value |
   |---|---|
   | `META_TOKEN` | the token from step 1.5 |
   | `PHONE_ID` | the Phone number ID from step 1.4 |
   | `VERIFY_TOKEN` | any word, for example `kithcars2026` |
   | `SHARED_SECRET` | a long random phrase |
   | `SB_URL` | `https://mxyrxyhvjndgjqupgstu.supabase.co` |
   | `SB_KEY` | the Supabase anon key (the one the CRM uses) |
   | `AUTOPILOT` | `test` |

4. Go to **Deploy → New deployment → Web app**, with Execute as **Me** and Who has access **Anyone**. Copy the `/exec` address.
5. In Meta, go to **developers.facebook.com → your app → WhatsApp → Configuration → Webhook**:
   - Callback URL: the `/exec` address
   - Verify token: your `VERIFY_TOKEN`
   - Subscribe to **messages**
6. In the editor, pick **`autopilotSetup`** from the function list and press **Run**. Approve the permissions. It adds the every-minute trigger and tells you if anything is missing.
7. In the CRM, open **⚙ Settings → Channels**. Paste the `/exec` address and the `SHARED_SECRET`, then press **Test the connection**. Every line should come back green.

### 4. Try it, then switch it on

1. Leave `AUTOPILOT` = `test` for a day. Then check:
   - New inbox enquiries get triaged and their replies wait on the Messages tab.
   - Intake jobs show "Autopilot (test mode) would send the range £X–£Y" in their log. Check the prices look right.
2. Send the business number a WhatsApp from your own phone. It should land in the inbox within seconds.
3. Set `AUTOPILOT` = `on`. The inbox banner turns green and says *Autopilot is on*.

---

## Still sent by a person for now

- **Email and text messages.** The autopilot only sends WhatsApp. Email/SMS-only messages stay on the Messages tab, one tap each.
- **Bot questions asking a website lead for missing details** (reg, number) when the customer has never messaged us on WhatsApp. These need their own template, which comes in the next round.
- **Booking confirmations, day-before reminders and the chase calls.** These are next on the build list, and will use this same autopilot.
