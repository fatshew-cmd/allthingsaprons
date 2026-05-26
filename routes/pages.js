const express = require('express');
const router  = express.Router();

const mockItems = [
  {
    _id: 'mock1',
    mediaUrl:    'https://picsum.photos/seed/apron5/500/625',
    title:       'Pro Butcher Apron',
    tags:        ['Chef Series'],
    authorName:  '@protools_co',
    ratingScore: 4.7,
    ratingCount: 210,
  },
  {
    _id: 'mock2',
    mediaUrl:    'https://picsum.photos/seed/apron4/500/625',
    title:       'Rustic Denim Half Apron',
    tags:        ['Kitchen Wear'],
    authorName:  '@the_craft_den',
    ratingScore: 4.1,
    ratingCount: 89,
  },
  {
    _id: 'mock3',
    mediaUrl:    'https://picsum.photos/seed/apron1/500/625',
    title:       'Classic Linen Bib Apron',
    tags:        ['Apron Design'],
    authorName:  '@maker_studio',
    ratingScore: 3.6,
    ratingCount: 124,
  },
  {
    _id: 'mock4',
    mediaUrl:    'https://picsum.photos/seed/apron6/500/625',
    title:       'Waxed Garden Apron',
    tags:        ['Garden Line'],
    authorName:  '@greenthumbs',
    ratingScore: 3.2,
    ratingCount: 57,
  },
];

const mockPairs = [
  {
    a: { mediaUrl: 'https://picsum.photos/seed/apron2/300/400', title: 'Canvas Cross-Back' },
    b: { mediaUrl: 'https://picsum.photos/seed/apron3/300/400', title: 'Waxed Cotton Chef' },
    pctA: 62,
  },
  {
    a: { mediaUrl: 'https://picsum.photos/seed/apron7/300/400', title: 'Striped Bistro' },
    b: { mediaUrl: 'https://picsum.photos/seed/apron8/300/400', title: 'Raw Denim Bib' },
    pctA: 44,
  },
  {
    a: { mediaUrl: 'https://picsum.photos/seed/apron9/300/400', title: 'Linen Pinafore' },
    b: { mediaUrl: 'https://picsum.photos/seed/apron10/300/400', title: 'Leather Barista' },
    pctA: 57,
  },
];

const trendingItems = [...mockItems].sort((a, b) => b.ratingScore - a.ratingScore).slice(0, 5);


const mockContests = [
  {
    _id: 'cont1',
    title: 'The Great Grill-Off',
    theme: 'BBQ & Outdoor Cooking',
    description: 'Design the ultimate apron for summer grilling. Bold, heat-resistant, and built for the pit.',
    organizer: '@atap',
    visibility: 'public',
    voteAccess: 'anyone',
    enterAccess: 'anyone',
    status: 'active',
    daysLeft: 8,
    submissionCount: 47,
    coverUrl: 'https://picsum.photos/seed/grill1/400/400',
  },
  {
    _id: 'cont2',
    title: 'Garden Party',
    theme: 'Botanical & Garden',
    description: 'Nature-inspired aprons for the green-thumb crowd. Think linen, flora, and earthy tones.',
    organizer: '@atap',
    visibility: 'public',
    voteAccess: 'anyone',
    enterAccess: 'anyone',
    status: 'active',
    daysLeft: 14,
    submissionCount: 31,
    coverUrl: 'https://picsum.photos/seed/garden2/400/400',
  },
  {
    _id: 'cont3',
    title: 'Café Noir',
    theme: 'Coffee & Café Culture',
    description: 'Channel your inner barista. Dark aesthetics, artisan craft, coffee-stained elegance.',
    organizer: '@atap',
    visibility: 'public',
    voteAccess: 'anyone',
    enterAccess: 'anyone',
    status: 'upcoming',
    daysLeft: 21,
    submissionCount: 0,
    coverUrl: 'https://picsum.photos/seed/cafe3/400/400',
  },
];

router.get('/', (req, res) => {
  res.redirect('/feed');
});

router.get('/feed', (req, res) => {
  res.render('feed', {
    title:            'Feed',
    activePage:       'feed',
    items:            mockItems,
    pairs:            mockPairs,
    trendingItems,
    contests:         mockContests,
  });
});

router.get('/leaderboard', (req, res) => {
  const sorted = [...mockItems].sort((a, b) => b.ratingScore - a.ratingScore);
  res.render('leaderboard', {
    title:            'Leaderboard',
    activePage:       'leaderboard',
    items:            sorted,
    trendingItems:    sorted.slice(0, 5),
    contests:         mockContests,
  });
});

router.get('/search', (req, res) => {
  res.render('search', {
    title:            'Search',
    activePage:       'search',
    trendingItems,
    contests:         mockContests,
  });
});

router.get(['/profile', '/profile/:id'], (req, res) => {
  res.render('profile', {
    title:            'Profile',
    activePage:       'profile',
    trendingItems,
    contests:         mockContests,
  });
});

router.get('/settings', (req, res) => {
  res.render('settings', {
    title:            'Settings',
    activePage:       'settings',
    trendingItems,
    contests:         mockContests,
  });
});

router.get('/contests', (req, res) => {
  res.render('contests', {
    title:      'Contests',
    activePage: 'contests',
    trendingItems,
    contests:   mockContests,
  });
});

router.get('/notifications', (req, res) => {
  res.render('notifications', {
    title:      'Notifications',
    activePage: 'notifications',
    trendingItems,
    contests:   mockContests,
  });
});

router.get('/messages', (req, res) => {
  res.render('messages', {
    title:      'Messages',
    activePage: 'messages',
    trendingItems,
    contests:   mockContests,
  });
});

module.exports = router;
