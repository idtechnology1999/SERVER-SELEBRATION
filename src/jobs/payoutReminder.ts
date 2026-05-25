import cron from 'node-cron';
import { User } from '../models/User.js';
import { Commission } from '../models/Commission.js';
import { sendMail } from '../utils/mailer.js';

async function runPayoutReminder() {
  // Find all users who have withdrawable or pending commissions
  const eligible = await Commission.aggregate([
    { $match: { status: { $in: ['pending', 'withdrawable'] } } },
    { $group: { _id: '$beneficiary', total: { $sum: '$amount' } } },
    { $match: { total: { $gt: 0 } } },
  ]);

  if (eligible.length === 0) {
    console.log('[payoutReminder] No users with withdrawable balance.');
    return;
  }

  const userIds = eligible.map((e: any) => e._id);
  const users = await User.find({ _id: { $in: userIds } }).select('name email');

  const balanceMap: Record<string, number> = {};
  for (const e of eligible) balanceMap[e._id.toString()] = e.total;

  for (const user of users) {
    const balance = balanceMap[user._id.toString()] ?? 0;

    await sendMail(user.email, '💰 Payout Day is Today — Request Your Withdrawal!', `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:0;background:#f9f9f9;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#08192E,#0D2847);padding:32px;text-align:center;">
          <p style="color:rgba(255,255,255,0.5);margin:8px 0 0;font-size:13px;">Selebration</p>
        </div>
        <div style="padding:32px;">
          <p style="font-size:16px;color:#111;">Hi <strong>${user.name}</strong>,</p>
          <p style="color:#333;">Great news — today is the <strong>14th</strong>, which means it's <strong>Payout Day</strong> on Selebration! 🎉</p>
          <p style="color:#333;">You have earnings available in your account. Head to your dashboard and submit a withdrawal request today.</p>

          <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid #1CB957;border-radius:10px;">
            <p style="margin:0;font-size:13px;color:#666;text-transform:uppercase;letter-spacing:1px;">Your Withdrawable Balance</p>
            <p style="margin:4px 0 0;font-size:48px;font-weight:900;color:#1CB957;line-height:1;">
              ₦${balance.toLocaleString()}
            </p>
          </div>

          <div style="text-align:center;margin-top:24px;">
            <a href="${process.env.FRONTEND_URL}/dashboard/withdraw"
               style="display:inline-block;background:#F5820A;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">
              Withdraw Now →
            </a>
          </div>

          <p style="font-size:13px;color:#555;margin-top:24px;">
            Payouts are processed every <strong>14th of the month</strong>. Make sure your bank account details are saved in your profile before submitting.
          </p>
          <p style="font-size:12px;color:#aaa;margin-top:16px;text-align:center;">
            You're receiving this because you have earnings on Selebration.
          </p>
        </div>
      </div>
    `).catch((err: any) => {
      console.error(`[payoutReminder] Failed to email ${user.email}:`, err.message);
    });
  }

  console.log(`[payoutReminder] Notified ${users.length} users about payout day`);
}

export function startPayoutReminderJob() {
  // Run at 8:00 AM on the 14th of every month
  cron.schedule('0 8 14 * *', () => {
    console.log('[payoutReminder] Running payout day reminder...');
    runPayoutReminder().catch(err => console.error('[payoutReminder] Error:', err.message));
  });

  console.log('[payoutReminder] Payout reminder job scheduled (08:00 on 14th of every month)');
}
