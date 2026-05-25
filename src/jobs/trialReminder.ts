import cron from 'node-cron';
import { User } from '../models/User.js';
import { sendMail } from '../utils/mailer.js';

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

async function runTrialReminder() {
  const now = new Date();

  // ── 1. Expire users whose 7-day trial has just ended ──────────────────────
  await User.updateMany(
    { subscription: 'trial', trialEndsAt: { $lt: now } },
    { subscription: 'expired' }
  );

  // ── 2. Active trial users — daily countdown emails ────────────────────────
  const trialUsers = await User.find({
    subscription: 'trial',
    trialEndsAt: { $gte: now },
  }).select('name email trialEndsAt referralCode');

  for (const user of trialUsers) {
    const msLeft = new Date(user.trialEndsAt!).getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    const isLastDay = daysLeft <= 1;
    const urgencyColor = daysLeft <= 2 ? '#EF4444' : '#F5820A';
    const frontendUrl = FRONTEND_URL();
    const referralLink = `${frontendUrl}/register?ref=${(user as any).referralCode || ''}`;

    const subject = isLastDay
      ? 'Today is your last free trial day — upgrade now!'
      : `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;

    const message = isLastDay
      ? `<p style="font-size:15px;color:#333;">Your free trial <strong style="color:#EF4444;">expires today</strong>. After today you will lose access to all free courses and videos.</p>`
      : `<p style="font-size:15px;color:#333;">You have <strong style="color:${urgencyColor};">${daysLeft} day${daysLeft === 1 ? '' : 's'} left</strong> on your free trial. Don't miss out — upgrade to keep learning and start earning!</p>`;

    await sendMail(user.email, subject, `
      <div style="font-family:sans-serif;max-width:560px;margin:auto;padding:0;background:#f9f9f9;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#08192E,#0D2847);padding:32px;text-align:center;">
          <p style="color:rgba(255,255,255,0.6);margin:0;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Selebration</p>
        </div>
        <div style="padding:32px;">
          <p style="font-size:16px;color:#111;">Hi <strong>${user.name}</strong>,</p>
          ${message}

          <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid ${urgencyColor};border-radius:10px;">
            <p style="margin:0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px;">Days Remaining</p>
            <p style="margin:4px 0 0;font-size:56px;font-weight:900;color:${urgencyColor};line-height:1;">${isLastDay ? '0' : daysLeft}</p>
          </div>

          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin:24px 0;">
            <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#111;">💰 Start earning with referrals</p>
            <p style="margin:0 0 12px;font-size:13px;color:#555;">Share your referral link — when the people you refer buy a course, you earn commission. <strong>Upgrade first</strong> to activate your earnings.</p>
            <div style="background:#f3f4f6;border-radius:8px;padding:12px;word-break:break-all;font-size:13px;color:#374151;">${referralLink}</div>
            <table style="width:100%;margin-top:16px;border-collapse:collapse;font-size:13px;">
              <tr style="background:#F5820A;color:#fff;">
                <th style="padding:8px 12px;text-align:left;">Level</th>
                <th style="padding:8px 12px;text-align:center;">Commission</th>
                <th style="padding:8px 12px;text-align:right;">Per ₦5k sale</th>
              </tr>
              <tr style="background:#fff;"><td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;">Level 1 (Direct)</td><td style="padding:7px 12px;text-align:center;font-weight:700;color:#F5820A;border-bottom:1px solid #f3f4f6;">65%</td><td style="padding:7px 12px;text-align:right;border-bottom:1px solid #f3f4f6;">₦3,250</td></tr>
              <tr style="background:#fafafa;"><td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;">Level 2</td><td style="padding:7px 12px;text-align:center;border-bottom:1px solid #f3f4f6;">15%</td><td style="padding:7px 12px;text-align:right;border-bottom:1px solid #f3f4f6;">₦750</td></tr>
              <tr style="background:#fff;"><td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;">Level 3</td><td style="padding:7px 12px;text-align:center;border-bottom:1px solid #f3f4f6;">5%</td><td style="padding:7px 12px;text-align:right;border-bottom:1px solid #f3f4f6;">₦250</td></tr>
              <tr style="background:#fafafa;"><td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;">Level 4</td><td style="padding:7px 12px;text-align:center;border-bottom:1px solid #f3f4f6;">3%</td><td style="padding:7px 12px;text-align:right;border-bottom:1px solid #f3f4f6;">₦150</td></tr>
              <tr style="background:#fff;"><td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;">Level 5</td><td style="padding:7px 12px;text-align:center;border-bottom:1px solid #f3f4f6;">2%</td><td style="padding:7px 12px;text-align:right;border-bottom:1px solid #f3f4f6;">₦100</td></tr>
              <tr style="background:#fafafa;"><td style="padding:7px 12px;">Level 6</td><td style="padding:7px 12px;text-align:center;">1%</td><td style="padding:7px 12px;text-align:right;">₦50</td></tr>
            </table>
            <p style="margin:12px 0 0;font-size:12px;color:#aaa;">⚠️ You must upgrade before your commissions are counted.</p>
          </div>

          <div style="text-align:center;margin-top:8px;">
            <a href="${frontendUrl}/dashboard/courses"
               style="display:inline-block;background:#F5820A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">
              Upgrade Now →
            </a>
          </div>
          <p style="font-size:12px;color:#aaa;margin-top:24px;text-align:center;">
            You're receiving this because you have an active free trial on Selebration.
          </p>
        </div>
      </div>
    `).catch((err: any) => {
      console.error(`[trialReminder] Failed to email ${user.email}:`, err.message);
    });
  }

  // ── 3. Grace period: expired trial users who never paid ───────────────────
  // stage=0 means they never paid for any course level
  const day1After = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const day2After = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const day3After = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  // Day 1 grace: expired between 1–2 days ago
  const grace1Users = await User.find({
    subscription: 'expired',
    stage: 0,
    trialEndsAt: { $gte: day2After, $lt: day1After },
  }).select('name email');

  for (const user of grace1Users) {
    const frontendUrl = FRONTEND_URL();
    await sendMail(user.email, '⚠️ Your Selebration trial has ended — upgrade to keep your account', `
      <div style="font-family:sans-serif;max-width:560px;margin:auto;background:#f9f9f9;border-radius:12px;overflow:hidden;">
        <div style="background:#EF4444;padding:24px 32px;text-align:center;">
          <p style="color:#fff;margin:0;font-size:18px;font-weight:700;">Free Trial Ended</p>
        </div>
        <div style="padding:32px;">
          <p style="font-size:16px;color:#111;">Hi <strong>${user.name}</strong>,</p>
          <p style="color:#333;font-size:15px;">Your 7-day free trial has ended. <strong>You have 1 day left</strong> to upgrade before your account is permanently removed from Selebration.</p>

          <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid #EF4444;border-radius:10px;">
            <p style="margin:0;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;">Days Until Account Removal</p>
            <p style="margin:4px 0 0;font-size:56px;font-weight:900;color:#EF4444;line-height:1;">1</p>
          </div>

          <p style="color:#555;font-size:14px;">Upgrade to any course level to keep your account, unlock your referral earnings, and start building income.</p>

          <div style="text-align:center;margin-top:24px;">
            <a href="${frontendUrl}/dashboard/courses"
               style="display:inline-block;background:#EF4444;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">
              Upgrade Now to Save Your Account →
            </a>
          </div>
          <p style="font-size:12px;color:#aaa;margin-top:24px;text-align:center;">
            If you no longer wish to continue, no action is needed and your account will be removed automatically.
          </p>
        </div>
      </div>
    `).catch((err: any) => {
      console.error(`[trialReminder] Grace-1 email failed for ${user.email}:`, err.message);
    });
  }

  // Day 2 grace: expired between 2–3 days ago — final warning
  const grace2Users = await User.find({
    subscription: 'expired',
    stage: 0,
    trialEndsAt: { $gte: day3After, $lt: day2After },
  }).select('name email');

  for (const user of grace2Users) {
    const frontendUrl = FRONTEND_URL();
    await sendMail(user.email, '🚨 FINAL WARNING: Your Selebration account will be deleted in 24 hours', `
      <div style="font-family:sans-serif;max-width:560px;margin:auto;background:#f9f9f9;border-radius:12px;overflow:hidden;">
        <div style="background:#7F1D1D;padding:24px 32px;text-align:center;">
          <p style="color:#fff;margin:0;font-size:18px;font-weight:700;">🚨 Final Warning</p>
        </div>
        <div style="padding:32px;">
          <p style="font-size:16px;color:#111;">Hi <strong>${user.name}</strong>,</p>
          <p style="color:#333;font-size:15px;"><strong>This is your last chance.</strong> Your Selebration account will be <strong style="color:#EF4444;">permanently deleted within 24 hours</strong> unless you upgrade to a paid course level.</p>

          <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid #7F1D1D;border-radius:10px;">
            <p style="margin:0;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;">Account Deleted In</p>
            <p style="margin:4px 0 0;font-size:56px;font-weight:900;color:#7F1D1D;line-height:1;">24h</p>
          </div>

          <p style="color:#555;font-size:14px;">If you want to rejoin Selebration after your account is removed, you will need to register with a different email address.</p>

          <div style="text-align:center;margin-top:24px;">
            <a href="${frontendUrl}/dashboard/courses"
               style="display:inline-block;background:#7F1D1D;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">
              Upgrade Now — Last Chance →
            </a>
          </div>
          <p style="font-size:12px;color:#aaa;margin-top:24px;text-align:center;">
            Your account will be automatically removed if no action is taken.
          </p>
        </div>
      </div>
    `).catch((err: any) => {
      console.error(`[trialReminder] Grace-2 email failed for ${user.email}:`, err.message);
    });
  }

  // ── 4. Delete accounts expired > 3 days ago with no payment ──────────────
  const deleted = await User.deleteMany({
    subscription: 'expired',
    stage: 0,
    trialEndsAt: { $lt: day3After },
  });

  if (deleted.deletedCount > 0) {
    console.log(`[trialReminder] Deleted ${deleted.deletedCount} expired free trial accounts`);
  }

  console.log(`[trialReminder] Processed ${trialUsers.length} active trials, ${grace1Users.length + grace2Users.length} grace period users`);
}

export function startTrialReminderJob() {
  cron.schedule('0 8 * * *', () => {
    console.log('[trialReminder] Running daily trial reminder...');
    runTrialReminder().catch(err => console.error('[trialReminder] Error:', err.message));
  });

  console.log('[trialReminder] Daily trial reminder job scheduled (08:00 every day)');
}
