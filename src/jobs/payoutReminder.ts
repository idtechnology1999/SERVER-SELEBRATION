import cron from 'node-cron';
import { User } from '../models/User.js';
import { Commission } from '../models/Commission.js';
import { Notification } from '../models/Notification.js';
import { sendMail } from '../utils/mailer.js';
import { emit } from '../socket.js';
import {
  PAYOUT_CRON, PAYOUT_TIMEZONE, balanceFor, lastPayoutRelease, minWithdrawal, releaseCommissions,
} from '../utils/payouts.js';

// Every Thursday at 10pm (Nigeria time): release the week's commissions,
// then tell everyone with enough to withdraw.
export async function runWeeklyPayout(now = new Date()) {
  const released = await releaseCommissions(now);
  console.log(`[weeklyPayout] Released ${released} commissions`);

  const MIN = await minWithdrawal();
  const beneficiaries: string[] = await Commission.distinct('beneficiary', { status: { $in: ['withdrawable', 'withdrawn'] } });

  let notified = 0;
  for (const userId of beneficiaries) {
    const { available } = await balanceFor(userId, now);
    if (available < MIN) continue;

    const user = await User.findById(userId).select('name email');
    if (!user) continue;
    notified++;

    await Notification.create({
      userId,
      userType: 'student',
      type: 'system',
      title: 'Your weekly earnings are ready',
      message: `₦${available.toLocaleString()} is available to withdraw.`,
    }).catch(() => {});
    emit('notification:new', { userId });

    await sendMail(user.email, '💰 Your weekly earnings are ready to withdraw', `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:0;background:#f9f9f9;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#08192E,#0D2847);padding:32px;text-align:center;">
          <p style="color:rgba(255,255,255,0.5);margin:8px 0 0;font-size:13px;">Selebration</p>
        </div>
        <div style="padding:32px;">
          <p style="font-size:16px;color:#111;">Hi <strong>${user.name}</strong>,</p>
          <p style="color:#333;">This week's earnings have been released. You can request a withdrawal now. 🎉</p>

          <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid #1CB957;border-radius:10px;">
            <p style="margin:0;font-size:13px;color:#666;text-transform:uppercase;letter-spacing:1px;">Available to withdraw</p>
            <p style="margin:4px 0 0;font-size:48px;font-weight:900;color:#1CB957;line-height:1;">
              ₦${available.toLocaleString()}
            </p>
          </div>

          <div style="text-align:center;margin-top:24px;">
            <a href="${process.env.FRONTEND_URL}/dashboard/withdraw"
               style="display:inline-block;background:#F5820A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">
              Withdraw Now →
            </a>
          </div>

          <p style="font-size:13px;color:#555;margin-top:24px;">
            Earnings are released every <strong>Thursday at 10pm</strong>. The minimum withdrawal is ₦${MIN.toLocaleString()}.
            Make sure your bank account details are saved before you request a withdrawal.
          </p>
          <p style="font-size:12px;color:#aaa;margin-top:16px;text-align:center;">
            You're receiving this because you have earnings on Selebration.
          </p>
        </div>
      </div>
    `).catch((err: any) => {
      console.error(`[weeklyPayout] Failed to email ${user.email}:`, err.message);
    });
  }

  console.log(`[weeklyPayout] Notified ${notified} users`);
}

export function startPayoutReminderJob() {
  // Catch up if the server was down at the last Thursday 10pm (no emails, just release).
  releaseCommissions(lastPayoutRelease())
    .then(n => { if (n > 0) console.log(`[weeklyPayout] Catch-up released ${n} commissions`); })
    .catch(err => console.error('[weeklyPayout] Catch-up error:', err.message));

  cron.schedule(PAYOUT_CRON, () => {
    console.log('[weeklyPayout] Running weekly payout release...');
    runWeeklyPayout().catch(err => console.error('[weeklyPayout] Error:', err.message));
  }, { timezone: PAYOUT_TIMEZONE });

  console.log('[weeklyPayout] Scheduled every Thursday 22:00 (Africa/Lagos)');
}
