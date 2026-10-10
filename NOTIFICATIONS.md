# Payment reminders

The system checks every hour (and when someone presses **Check for overdue bills now** on the Notifications page) for
**issued** bills that still have a balance and a due date. Each bill triggers one reminder per stage:

| Stage | When |
|---|---|
| Due soon | `NOTIFY_DUE_SOON_DAYS` before the due date (default 3) |
| Due today | on the due date |
| Overdue | the day after the due date, then every `NOTIFY_OVERDUE_REPEAT_DAYS` days (default 7) until paid |

A bill that is paid stops getting reminders, and queued emails for it are cancelled.

**Who is told**
- Client: every active viewer login of that client, plus the client's primary contact email (or every contact with an email if none is marked primary).
- Finance: every active Finance / HR user (administrators if there are none).
- Everyone with a login gets a notification in the system (Notifications link, with an unread count). Everyone with an email address gets an email.

**Setup**
1. `npm install` (adds `nodemailer`).
2. Add the SMTP settings from `.env.example` to `.env`, and set `APP_BASE_URL` so emails link to the right place.
3. **Users**: add an email address for each finance user and client login. Client contacts use the emails already on the client page.
4. Restart. Until SMTP is set up, reminders appear in the system only; the emails wait and are sent automatically once email works.

Failed emails are retried on the next hourly check, up to 3 times. Finance and administrators can see every reminder and the result of each email under **Notifications > Reminder log**, and each reminder also appears in the Activity log.

Days are counted in Philippine time (`APP_TIMEZONE`).
