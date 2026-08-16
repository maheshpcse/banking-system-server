const express = require('express');
const auth = require('../middleware/auth');
const Notification = require('../models/Notification');

const router = express.Router();

router.use(auth);

function toItem(doc) {
  return typeof doc.toSafeJSON === 'function' ? doc.toSafeJSON() : {
    id: doc._id.toString(),
    kind: doc.kind,
    title: doc.title,
    body: doc.body,
    href: doc.href || undefined,
    createdAt: doc.createdAt,
    read: !!doc.read
  };
}

/** Create a notification for the authenticated user (or server helpers). */
async function createNotification({ userId, kind, title, body, href }) {
  const doc = await Notification.create({
    user: userId,
    kind: kind || 'system',
    title,
    body,
    href: href || null,
    read: false
  });
  return doc;
}

router.get('/', async (req, res) => {
  try {
    const items = await Notification.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100);
    return res.json({
      items: items.map(toItem),
      unreadCount: items.filter((n) => !n.read).length
    });
  } catch (error) {
    console.error('List notifications error:', error);
    return res.status(500).json({ message: 'Unable to load notifications' });
  }
});

router.post('/', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    const kind = String(req.body.kind || 'system');
    const href = req.body.href ? String(req.body.href) : null;

    if (!title || !body) {
      return res.status(400).json({ message: 'Title and body are required' });
    }

    const doc = await createNotification({
      userId: req.user._id,
      kind,
      title,
      body,
      href
    });

    return res.status(201).json({ message: 'Notification saved', item: toItem(doc) });
  } catch (error) {
    console.error('Create notification error:', error);
    return res.status(500).json({ message: 'Unable to save notification' });
  }
});

router.patch('/:id/read', async (req, res) => {
  try {
    const doc = await Notification.findOne({ _id: req.params.id, user: req.user._id });
    if (!doc) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    doc.read = true;
    await doc.save();
    return res.json({ message: 'Marked read', item: toItem(doc) });
  } catch (error) {
    console.error('Mark read error:', error);
    return res.status(500).json({ message: 'Unable to update notification' });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
    const items = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100);
    return res.json({ message: 'All notifications marked read', items: items.map(toItem) });
  } catch (error) {
    console.error('Mark all read error:', error);
    return res.status(500).json({ message: 'Unable to update notifications' });
  }
});

module.exports = router;
module.exports.createNotification = createNotification;
