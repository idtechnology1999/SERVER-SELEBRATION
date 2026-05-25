import { Router } from 'express';
import type { Response } from 'express';
import { User } from '../../models/User.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { sendMail } from '../../utils/mailer.js';

const router = Router();
router.use(requireAuth);

// Target options:
//  all | trial | active | expired | cancelled | stage-0 | stage-1 | stage-2 | stage-3
function buildQuery(target: string): Record<string, any> {
  switch (target) {
    case 'all':       return {};
    case 'trial':     return { subscription: 'trial' };
    case 'active':    return { subscription: 'active' };
    case 'expired':   return { subscription: 'expired' };
    case 'cancelled': return { subscription: 'cancelled' };
    case 'stage-0':   return { stage: 0 };
    case 'stage-1':   return { stage: 1 };
    case 'stage-2':   return { stage: 2 };
    case 'stage-3':   return { stage: 3 };
    default:          return {};
  }
}

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { target, subject, body } = req.body;
    if (!target || !subject || !body) {
      res.status(400).json({ success: false, message: 'Target, subject, and body are required' });
      return;
    }

    const query = buildQuery(target);
    const users = await User.find(query).select('name email');

    if (users.length === 0) {
      res.status(404).json({ success: false, message: 'No users found for the selected target' });
      return;
    }

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      // Replace {{name}} placeholder in body with actual user name
      const personalised = body.replace(/\{\{name\}\}/gi, user.name);

      await sendMail(user.email, subject, `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:0;background:#f9f9f9;border-radius:12px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#08192E,#0D2847);padding:28px 32px;">
            <p style="color:rgba(255,255,255,0.5);margin:0;font-size:13px;">Selebration</p>
          </div>
          <div style="padding:32px;">
            <div style="font-size:15px;color:#333;line-height:1.7;white-space:pre-wrap;">${personalised}</div>
            <hr style="border:none;border-top:1px solid #eee;margin:28px 0;" />
            <p style="font-size:12px;color:#aaa;margin:0;">
              You're receiving this message from the Selebration team.
            </p>
          </div>
        </div>
      `).then(() => { sent++; }).catch(() => { failed++; });
    }

    res.json({
      success: true,
      message: `Email sent to ${sent} user${sent !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}.`,
      data: { total: users.length, sent, failed },
    });
  } catch (err: any) {
    console.error('[email-blast error]', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
