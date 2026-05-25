import cron from 'node-cron';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { sendMail } from '../utils/mailer.js';
import { emit } from '../socket.js';

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:5173';

// Warn at these thresholds (days before expiry)
const WARN_DAYS = [7, 3, 2, 1];

async function runSubscriptionExpiryReminder() {
  const now = new Date();

  // ── 1. Auto-expire lapsed active subscriptions ────────────────────────────
  const expired = await User.updateMany(
    { subscription: 'active', trialEndsAt: { $lt: now } },
    { subscription: 'expired' }
  );
  if (expired.modifiedCount > 0) {
    console.log(`[subscriptionExpiry] Expired ${expired.modifiedCount} subscriptions`);
  }

  // ── 2. Send renewal reminders at 7 / 3 / 2 / 1 days before expiry ────────
  // Query window: any user expiring in the next 7 days + 1 min buffer
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000 + 60_000);

  const users = await User.find({
    subscription: 'active',
    trialEndsAt: { $gte: now, $lte: in7Days },
  }).select('name email trialEndsAt _id');

  for (const user of users) {
    const msLeft = new Date(user.trialEndsAt!).getTime() - now.getTime();
    const daysLeft = Math.round(msLeft / (1000 * 60 * 60 * 24));

    // Only send on the specific warning days
    if (!WARN_DAYS.includes(daysLeft)) continue;

    const urgencyColor = daysLeft === 1 ? '#EF4444' : daysLeft === 2 ? '#F59E0B' : '#F5820A';
    const frontendUrl = FRONTEND_URL();

    const title = daysLeft === 1
      ? 'Your subscription expires today!'
      : `Your subscription expires in ${daysLeft} days`;

    const bodyMessage = daysLeft === 1
      ? 'Your subscription expires <strong>today</strong>. Renew now to keep earning and stay active.'
      : `Your subscription expires in <strong>${daysLeft} days</strong>. Renew before it runs out — your referral earnings and course access will stop the moment it expires.`;

    // In-app notification
    await Notification.create({
      userId: user._id.toString(),
      userType: 'student',
      title,
      message: title,
      type: 'system',
    });
    emit('notification:new', { userId: user._id.toString() });

    // Email
    await sendMail(user.email, title, `
      <div style="font-family:sans-serif;max-width:560px;margin:auto;background:#f9f9f9;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#08192E,#0D2847);padding:28px 32px;">
          <p style="color:rgba(255,255,255,0.6);margin:0;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Selebration</p>
        </div>
        <div style="padding:32px;">
          <p style="font-size:16px;color:#111;">Hi <strong>${user.name}</strong>,</p>
          <p style="color:#333;font-size:15px;">${bodyMessage}</p>

          <div style="text-align:center;margin:24px 0;padding:20px;background:#fff;border:2px solid ${urgencyColor};border-radius:10px;">
            <p style="margin:0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px;">Days Until Expiry</p>
            <p style="margin:4px 0 0;font-size:56px;font-weight:900;color:${urgencyColor};line-height:1;">${daysLeft}</p>
          </div>

          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:24px;">
            <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#111;">When your subscription expires you will:</p>
            <ul style="margin:0;padding-left:18px;color:#555;font-size:13px;line-height:2;">
              <li>Lose access to all course videos</li>
              <li>Stop earning commissions from referrals</li>
              <li>Your referral link will no longer be active</li>
            </ul>
          </div>

          <div style="text-align:center;">
            <a href="${frontendUrl}/dashboard/courses"
               style="display:inline-block;background:${urgencyColor};color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 36px;border-radius:8px;">
              Renew Subscription →
            </a>
          </div>

          <p style="font-size:12px;color:#aaa;margin-top:28px;text-align:center;">
            You're receiving this because your Selebration subscription is expiring soon.
          </p>
        </div>
      </div>
    `).catch((err: any) => {
      console.error(`[subscriptionExpiry] Failed to email ${user.email}:`, err.message);
    });
  }

  console.log(`[subscriptionExpiry] Processed ${users.length} expiry reminders`);
}

export function startSubscriptionExpiryJob() {
  cron.schedule('0 9 * * *', () => {
    console.log('[subscriptionExpiry] Checking subscriptions...');
    runSubscriptionExpiryReminder().catch(err =>
      console.error('[subscriptionExpiry] Error:', err.message)
    );
  });

  console.log('[subscriptionExpiry] Subscription expiry job scheduled (09:00 every day)');
}
